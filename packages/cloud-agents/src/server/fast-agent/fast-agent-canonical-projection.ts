import { createHash } from 'node:crypto';

import type { ModelMessage } from 'ai';

import type { FastAgentMessage } from '@roomote/db/server';
import {
  FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY,
  FAST_AGENT_EVENT_SEMANTICS_VERSION,
  type FastAgentEventAuthority,
  type FastAgentEventProjectionClassification,
  type FastAgentEventSemanticKind,
  type FastAgentEventSemantics,
} from '@roomote/types';

export const FAST_AGENT_CANONICAL_REDUCER_VERSION = 1;

export type FastAgentProjectedEvent = {
  event: FastAgentMessage;
  semantics: FastAgentEventSemantics | null;
  classification: FastAgentEventProjectionClassification;
};

export type FastAgentCanonicalProjection = {
  events: FastAgentProjectedEvent[];
  stateHash: string;
  projectedThroughSequence: number | null;
  currentStateEventIds: string[];
};

const AUTHORITY_RANK: Record<FastAgentEventAuthority, number> = {
  human: 1,
  delegated_task: 2,
  automation: 3,
  roomote_runtime: 4,
  source_control: 5,
};

/**
 * How strongly an event speaks about the present. A current-state assertion
 * reports what the subject is now, while a state change only records that a
 * transition happened; the latter can be re-emitted long after the fact (a
 * later task updating an already-merged pull request), so it must never
 * overwrite an assertion about current state. A legitimate reverse
 * transition still wins once its producer asserts it as current state.
 */
const STATE_EVIDENCE_RANK: Record<FastAgentEventSemanticKind, number> = {
  historical_observation: 0,
  state_change: 1,
  current_state_assertion: 2,
};

/**
 * Reads the immutable semantics an admission recorded on an event.
 *
 * Authority and kind are checked against the ranks that order them, not
 * merely for being strings: an unrecognized value would index those ranks as
 * `undefined` and make the ordering comparison `NaN`, which would silently
 * destroy the total order. An event whose semantics cannot be ranked is
 * treated as unsemantic history instead.
 *
 * The check is an own-property test, not `in`: every object inherits
 * `toString` and `constructor`, so `in` would accept those as a kind or an
 * authority and then rank them as a function, which is exactly the `NaN` this
 * guard exists to prevent.
 */
export function readFastAgentEventSemantics(
  event: Pick<FastAgentMessage, 'metadata'>,
): FastAgentEventSemantics | null {
  const value = event.metadata?.[FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const semantics = value as Partial<FastAgentEventSemantics>;
  if (
    semantics.schemaVersion !== FAST_AGENT_EVENT_SEMANTICS_VERSION ||
    typeof semantics.observedAt !== 'string' ||
    typeof semantics.sourceEventId !== 'string' ||
    typeof semantics.kind !== 'string' ||
    typeof semantics.authority !== 'string' ||
    !Object.hasOwn(STATE_EVIDENCE_RANK, semantics.kind) ||
    !Object.hasOwn(AUTHORITY_RANK, semantics.authority)
  ) {
    return null;
  }
  // A version that cannot be ordered numerically must not reach the key.
  if (
    semantics.version?.scheme === 'monotonic_number' &&
    !Number.isFinite(semantics.version.value)
  ) {
    return null;
  }
  return semantics as FastAgentEventSemantics;
}

/**
 * Whether the version can order a subject at all. Only a genuinely monotonic
 * scheme establishes precedence; an opaque version identifies a revision
 * without implying order.
 */
function monotonicVersion(semantics: FastAgentEventSemantics): number | null {
  return semantics.version?.scheme === 'monotonic_number'
    ? semantics.version.value
    : null;
}

/**
 * The single ordering key every state claim about one subject is compared by.
 *
 * Using one lexicographic key, rather than pairwise rules that differ by
 * which side happens to carry a version, is what makes the order total: the
 * winner cannot depend on admission order, and adding an unversioned claim
 * cannot reorder the versioned claims around it.
 *
 * Mixed-version policy: when a source numbers a subject's states, that
 * number is the most trustworthy ordering signal available, so a numbered
 * claim outranks an unnumbered one from the same authority and a higher
 * number always outranks a lower one. An unnumbered claim therefore cannot
 * regress a numbered state, and among unnumbered claims the stronger
 * statement about the present wins, then the later observation. A producer
 * that emits both numbered and unnumbered claims for one subject is
 * modelling that subject inconsistently; the numbered claims win there.
 */
function buildSubjectOrderingKey(candidate: FastAgentProjectedEvent): number[] {
  const semantics = candidate.semantics!;
  const version = monotonicVersion(semantics);
  const observedAt = Date.parse(semantics.observedAt);
  return [
    AUTHORITY_RANK[semantics.authority],
    version === null ? 0 : 1,
    version ?? 0,
    STATE_EVIDENCE_RANK[semantics.kind],
    Number.isFinite(observedAt) ? observedAt : 0,
    candidate.event.conversationSeq ?? 0,
  ];
}

function compareSubjectCandidates(
  left: FastAgentProjectedEvent,
  right: FastAgentProjectedEvent,
): number {
  const leftKey = buildSubjectOrderingKey(left);
  const rightKey = buildSubjectOrderingKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const difference = leftKey[index]! - rightKey[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether two claims about one subject disagree with no signal able to
 * separate them, which is reported rather than silently resolved.
 */
function isAmbiguousConflict(
  left: FastAgentProjectedEvent,
  right: FastAgentProjectedEvent,
): boolean {
  const leftSemantics = left.semantics!;
  const rightSemantics = right.semantics!;
  if (leftSemantics.authority !== rightSemantics.authority) return false;
  // A transition record disagreeing with an assertion about current state is
  // resolved by evidence strength, not surfaced as an unresolvable conflict.
  if (leftSemantics.kind !== rightSemantics.kind) return false;
  if (leftSemantics.state === rightSemantics.state) return false;
  const leftVersion = monotonicVersion(leftSemantics);
  const rightVersion = monotonicVersion(rightSemantics);
  if (leftVersion !== null && rightVersion !== null) {
    return leftVersion === rightVersion;
  }
  if (leftVersion !== null || rightVersion !== null) return false;
  if (
    leftSemantics.version?.scheme === 'opaque' &&
    rightSemantics.version?.scheme === 'opaque'
  ) {
    return leftSemantics.version.value === rightSemantics.version.value;
  }
  // Compare the instant, not its formatting, so the same observation time
  // written two ways is still recognized as inseparable.
  const leftObserved = Date.parse(leftSemantics.observedAt);
  const rightObserved = Date.parse(rightSemantics.observedAt);
  return (
    Number.isFinite(leftObserved) &&
    Number.isFinite(rightObserved) &&
    leftObserved === rightObserved
  );
}

/** Pure projection of immutable canonical facts into current conversational state. */
export function projectFastAgentCanonicalEvents(
  rows: FastAgentMessage[],
): FastAgentCanonicalProjection {
  const ordered = [...rows].sort((left, right) => {
    if (left.conversationSeq !== null && right.conversationSeq !== null) {
      return left.conversationSeq - right.conversationSeq;
    }
    if (left.conversationSeq !== null) return -1;
    if (right.conversationSeq !== null) return 1;
    return (
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.turnSeq - right.turnSeq ||
      left.id.localeCompare(right.id)
    );
  });
  const events: FastAgentProjectedEvent[] = ordered.map((event) => ({
    event,
    semantics: readFastAgentEventSemantics(event),
    classification: 'historical_relevant',
  }));
  const bySubject = new Map<string, FastAgentProjectedEvent[]>();
  for (const projected of events) {
    const semantics = projected.semantics;
    if (!semantics?.subject || semantics.kind === 'historical_observation') {
      continue;
    }
    const key = `${semantics.subject.type}:${semantics.subject.id}`;
    const values = bySubject.get(key) ?? [];
    values.push(projected);
    bySubject.set(key, values);
  }

  for (const candidates of bySubject.values()) {
    let winner = candidates[0]!;
    for (const candidate of candidates.slice(1)) {
      if (compareSubjectCandidates(candidate, winner) > 0) winner = candidate;
    }
    const conflicts = candidates.filter(
      (candidate) =>
        candidate !== winner && isAmbiguousConflict(candidate, winner),
    );
    if (conflicts.length > 0) {
      winner.classification = 'conflicting';
      for (const conflict of conflicts) conflict.classification = 'conflicting';
    } else {
      winner.classification = 'current';
    }
    for (const candidate of candidates) {
      if (candidate === winner || conflicts.includes(candidate)) continue;
      candidate.classification =
        candidate.semantics?.kind === 'state_change'
          ? 'historical_relevant'
          : 'superseded_irrelevant';
    }
  }

  const currentState = events
    .filter(
      ({ classification }) =>
        classification === 'current' || classification === 'conflicting',
    )
    .map(({ event, semantics, classification }) => ({
      eventId: event.eventId,
      classification,
      semantics,
    }));
  return {
    events,
    stateHash: createHash('sha256')
      .update(JSON.stringify(currentState))
      .digest('hex'),
    projectedThroughSequence: ordered.reduce<number | null>(
      (highest, event) =>
        event.conversationSeq === null
          ? highest
          : Math.max(highest ?? 0, event.conversationSeq),
      null,
    ),
    currentStateEventIds: currentState.map(({ eventId }) => eventId),
  };
}

/**
 * Whether a projected event is an obsolete state claim that must not be
 * announced as current. Consumers use this to skip a queued turn whose state
 * a newer event already replaced, so the rule lives here rather than being
 * restated wherever events are consumed.
 */
export function isFastAgentCanonicalEventSuperseded(
  projection: FastAgentCanonicalProjection,
  eventId: string,
): boolean {
  return (
    projection.events.find(({ event }) => event.eventId === eventId)
      ?.classification === 'superseded_irrelevant'
  );
}

/**
 * Historical attachments a rebuilt prompt must carry so a cold conversation
 * can still see images an earlier turn provided. Canonical rows keep the
 * image bytes, so a rebuild can restore real attachments rather than only
 * noting that one existed.
 */
export type FastAgentCanonicalAttachment = {
  eventId: string;
  mime: string;
  /** Data URL in the same shape the live turn's image path consumes. */
  url: string;
};

/** Most recent attachments to restore, newest first, bounded per rebuild. */
export const FAST_AGENT_CANONICAL_ATTACHMENT_LIMIT = 4;

export function collectFastAgentCanonicalAttachments(
  projection: FastAgentCanonicalProjection,
  options: { excludeEventId?: string; limit?: number } = {},
): FastAgentCanonicalAttachment[] {
  const limit = options.limit ?? FAST_AGENT_CANONICAL_ATTACHMENT_LIMIT;
  const restored: FastAgentCanonicalAttachment[] = [];
  // Walk newest first so the bound keeps the most recent attachments, which
  // are the ones a continuing conversation is most likely to still mean.
  for (const { event, classification } of [...projection.events].reverse()) {
    if (restored.length >= limit) break;
    if (event.eventId === options.excludeEventId) continue;
    if (classification === 'superseded_irrelevant') continue;
    if (event.role !== 'user') continue;
    for (const block of event.contentBlocks) {
      if (restored.length >= limit) break;
      if (block.type !== 'image') continue;
      const mime = String(
        (block as { mimeType?: unknown }).mimeType ?? '',
      ).trim();
      const data = String((block as { data?: unknown }).data ?? '').trim();
      if (!mime.startsWith('image/') || !data) continue;
      restored.push({
        eventId: event.eventId,
        mime,
        url: `data:${mime};base64,${data}`,
      });
    }
  }
  return restored;
}

function eventText(event: FastAgentMessage): string {
  return event.contentBlocks
    .flatMap((block) => (block.type === 'text' ? [String(block.text)] : []))
    .join('\n');
}

/**
 * The provenance header a canonical event carries into a prompt. Rebuilt
 * history and the current turn's own input both announce an event the same
 * way, so the shape lives here rather than being restated per call site.
 */
export function renderFastAgentCanonicalEventContext(params: {
  eventId: string;
  classification: FastAgentEventProjectionClassification;
  admittedAt: Date;
  semantics: FastAgentEventSemantics;
}): string {
  return `<canonical_event_context>${JSON.stringify({
    eventId: params.eventId,
    classification: params.classification,
    observedAt: params.semantics.observedAt,
    admittedAt: params.admittedAt.toISOString(),
    occurredAt: params.semantics.occurredAt,
    authority: params.semantics.authority,
    subject: params.semantics.subject,
    version: params.semantics.version,
  })}</canonical_event_context>`;
}

export function renderFastAgentCanonicalHistory(
  projection: FastAgentCanonicalProjection,
  options: { excludeEventId?: string } = {},
): ModelMessage[] {
  return projection.events.flatMap((projected) => {
    const { event, semantics, classification } = projected;
    if (event.eventId === options.excludeEventId) return [];
    if (classification === 'superseded_irrelevant') return [];
    if (event.role !== 'user' && event.role !== 'assistant') return [];
    const attachmentCount = event.contentBlocks.filter(
      (block) => block.type === 'image',
    ).length;
    const text = eventText(event).trim();
    // An image-only turn still happened. Dropping it would erase the turn
    // from rebuilt history entirely, so it is rendered with its attachment
    // count; the bytes themselves are restored separately as real files.
    if (!text && attachmentCount === 0) return [];
    const attachmentNote =
      attachmentCount > 0
        ? `<canonical_event_attachments count="${attachmentCount}" />`
        : '';
    const body = [attachmentNote, text].filter(Boolean).join('\n');
    const context = semantics
      ? `${renderFastAgentCanonicalEventContext({
          eventId: event.eventId,
          classification,
          admittedAt: event.createdAt,
          semantics,
        })}\n`
      : '';
    return [{ role: event.role, content: `${context}${body}` } as ModelMessage];
  });
}

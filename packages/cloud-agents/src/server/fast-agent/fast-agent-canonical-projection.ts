import { createHash } from 'node:crypto';

import type { ModelMessage } from 'ai';

import type { FastAgentMessage } from '@roomote/db/server';
import {
  FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY,
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

function readSemantics(
  event: FastAgentMessage,
): FastAgentEventSemantics | null {
  const value = event.metadata?.[FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const semantics = value as Partial<FastAgentEventSemantics>;
  return semantics.schemaVersion === 1 &&
    typeof semantics.kind === 'string' &&
    typeof semantics.authority === 'string' &&
    typeof semantics.observedAt === 'string' &&
    typeof semantics.sourceEventId === 'string'
    ? (semantics as FastAgentEventSemantics)
    : null;
}

/**
 * Compares two source-provided versions for the same subject. Only versions
 * that share a scheme are comparable, and only a genuinely monotonic scheme
 * establishes order; an opaque version can establish identity but never
 * precedence. Anything else is reported as incomparable so the caller falls
 * back to real observation order instead of an invented lifecycle.
 */
function compareVersion(
  left: FastAgentEventSemantics,
  right: FastAgentEventSemantics,
): number | null {
  if (!left.version || !right.version) return null;
  if (left.version.scheme !== right.version.scheme) return null;
  if (left.version.scheme === 'monotonic_number') {
    return left.version.value - (right.version as typeof left.version).value;
  }
  return left.version.value === right.version.value ? 0 : null;
}

function compareCandidate(
  left: FastAgentProjectedEvent,
  right: FastAgentProjectedEvent,
) {
  const leftSemantics = left.semantics!;
  const rightSemantics = right.semantics!;
  const authority =
    AUTHORITY_RANK[leftSemantics.authority] -
    AUTHORITY_RANK[rightSemantics.authority];
  if (authority !== 0) return authority;

  // What the event claims about the present outranks when it arrived. This is
  // what keeps a terminal status authoritative over an opening event that a
  // later task re-emits for the same pull request.
  const evidence =
    STATE_EVIDENCE_RANK[leftSemantics.kind] -
    STATE_EVIDENCE_RANK[rightSemantics.kind];
  if (evidence !== 0) return evidence;

  // A comparable monotonic version is the only signal allowed to outrank a
  // later observation. Without one, the freshest thing the source actually
  // told us wins, so a legitimate later transition is never pinned by an
  // earlier state.
  const version = compareVersion(leftSemantics, rightSemantics);
  if (version !== null && version !== 0) return version;

  const observed =
    Date.parse(leftSemantics.observedAt) -
    Date.parse(rightSemantics.observedAt);
  if (Number.isFinite(observed) && observed !== 0) return observed;

  return (left.event.conversationSeq ?? 0) - (right.event.conversationSeq ?? 0);
}

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
  const version = compareVersion(leftSemantics, rightSemantics);
  if (version !== null) return version === 0;
  return leftSemantics.observedAt === rightSemantics.observedAt;
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
    semantics: readSemantics(event),
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
      if (compareCandidate(candidate, winner) > 0) winner = candidate;
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

function eventText(event: FastAgentMessage): string {
  return event.contentBlocks
    .flatMap((block) => (block.type === 'text' ? [String(block.text)] : []))
    .join('\n');
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
    const text = eventText(event).trim();
    if (!text) return [];
    const context = semantics
      ? `<canonical_event_context>${JSON.stringify({
          eventId: event.eventId,
          classification,
          observedAt: semantics.observedAt,
          admittedAt: event.createdAt.toISOString(),
          occurredAt: semantics.occurredAt,
          authority: semantics.authority,
          subject: semantics.subject,
          version: semantics.version,
        })}</canonical_event_context>\n`
      : '';
    return [{ role: event.role, content: `${context}${text}` } as ModelMessage];
  });
}

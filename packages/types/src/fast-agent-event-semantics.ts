export const FAST_AGENT_EVENT_SEMANTICS_VERSION = 1 as const;

export type FastAgentEventSemanticKind =
  | 'historical_observation'
  | 'state_change'
  | 'current_state_assertion';

export type FastAgentEventAuthority =
  | 'human'
  | 'roomote_runtime'
  | 'delegated_task'
  | 'source_control'
  | 'automation';

export type FastAgentEventSubject = {
  type: string;
  id: string;
};

/**
 * A version the source itself provides. `monotonic_number` is the only scheme
 * that establishes precedence, and only where the producer genuinely
 * guarantees monotonicity (a wakeup run number, an artifact version).
 * `opaque` establishes identity for a specific revision, such as a review
 * head SHA, without implying an order. Lifecycles without a provider-supplied
 * version stay unversioned and are ordered by observation time instead.
 */
export type FastAgentEventVersion =
  | { scheme: 'monotonic_number'; value: number }
  | { scheme: 'opaque'; value: string };

/**
 * Immutable semantics attached to a canonical Fast Session input. Reducer
 * classifications are deliberately derived rather than persisted.
 */
export type FastAgentEventSemantics = {
  schemaVersion: typeof FAST_AGENT_EVENT_SEMANTICS_VERSION;
  kind: FastAgentEventSemanticKind;
  authority: FastAgentEventAuthority;
  observedAt: string;
  occurredAt?: string;
  subject?: FastAgentEventSubject;
  version?: FastAgentEventVersion;
  /** Stable serialization of the asserted state, used only within its subject. */
  state?: string;
  sourceEventId: string;
};

export const FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY =
  'fastAgentEventSemantics' as const;

/**
 * Semantics for a human or platform-event Session input.
 *
 * Durable queue admission and a turn that persists its own input both write
 * the same canonical row, so the rule for what such an input claims lives
 * here once rather than being restated by each writer.
 */
export function buildFastAgentInputSemantics(params: {
  sessionId: string;
  observedAt: Date;
  sourceEventId: string;
  platformEvent: boolean;
  /** Present only for a setup platform event, which asserts current state. */
  setupSnapshot?: string | undefined;
}): FastAgentEventSemantics {
  const base = {
    schemaVersion: FAST_AGENT_EVENT_SEMANTICS_VERSION,
    observedAt: params.observedAt.toISOString(),
    sourceEventId: params.sourceEventId,
  } as const;
  if (params.platformEvent && params.setupSnapshot) {
    return {
      ...base,
      kind: 'current_state_assertion',
      authority: 'roomote_runtime',
      subject: { type: 'setup_session', id: params.sessionId },
      state: params.setupSnapshot,
    };
  }
  return {
    ...base,
    kind: 'historical_observation',
    authority: params.platformEvent ? 'roomote_runtime' : 'human',
  };
}

export type FastAgentEventProjectionClassification =
  | 'current'
  | 'historical_relevant'
  | 'superseded_irrelevant'
  | 'conflicting';

export type FastAgentAssistantClaimProvenance = {
  reducerVersion: number;
  projectedThroughSequence: number | null;
  projectionHash: string;
  eventIds: string[];
};

export const FAST_AGENT_ASSISTANT_CLAIM_PROVENANCE_METADATA_KEY =
  'fastAgentClaimProvenance' as const;

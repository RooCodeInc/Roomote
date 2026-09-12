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

export type FastAgentEventVersion =
  | { scheme: 'monotonic_number'; value: number }
  | { scheme: 'domain_order'; value: number }
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

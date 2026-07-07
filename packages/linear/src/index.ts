// Types
export type {
  AgentSessionState,
  AgentSessionEventAction,
  HumanToAgentSignal,
  LinearIssue,
  LinearComment,
  LinearUser,
  AgentGuidance,
  AgentSession,
  WebhookAgentActivityContent,
  WebhookAgentActivity,
  AgentSessionEventPayload,
  LinearWebhookPayload,
  AgentActivityType,
  AgentActivity,
  AgentActivityResult,
  LinearOAuthTokenResponse,
  LinearTokenRefreshResult,
  LinearViewer,
  LinearOrganization,
  LinearSessionMessage,
  ActiveLinearJobResult,
  AgentSessionPlanStepStatus,
  AgentSessionPlanStep,
  AgentSessionUpdateResult,
} from './types';

// Payload parsing with Zod validation
export {
  agentSessionEventPayloadSchema,
  parseAgentSessionEventPayload,
} from './types';

// LinearClient
export { LinearClient, createLinearClient } from './linear-client';

// Webhook verification
export {
  verifyLinearWebhookSignature,
  isWebhookTimestampValid,
} from './verify-webhook';

// Active job lookup
export {
  findActiveLinearJob,
  findActiveLinearJobByOrganization,
} from './find-active-linear-job';

// Completed job with snapshot lookup (for snapshot resume)
export { findCompletedLinearJobWithSnapshot } from './find-completed-linear-job-with-snapshot';

// Message queue
export {
  queueLinearMessage,
  prependLinearMessages,
  clearLinearMessageQueue,
} from './queue-linear-message';
export {
  setPendingLinearRequestUserInput,
  getPendingLinearRequestUserInput,
  clearPendingLinearRequestUserInput,
  markPendingLinearRequestUserInputSubmitted,
  queueLinearRequestUserInputAnswer,
  prependLinearRequestUserInputAnswers,
  getLinearRequestUserInputAnswers,
} from './request-user-input';
export type {
  PendingLinearRequestUserInput,
  QueuedLinearRequestUserInputAnswer,
} from './request-user-input';

// Get queued messages (used by worker)
export { getLinearMessages } from './get-linear-messages';

// Non-destructive peek at message count (used by snapshot drain)
export { peekLinearMessageCount } from './peek-linear-messages';

// Drain pending Linear messages and create a SnapshotResume job
export type { DrainSourceJob, DrainResult } from './drain-linear-messages';
export { drainLinearMessagesToResumeJob } from './drain-linear-messages';

// Cancel job (used when user sends stop signal)
export type { CancelLinearJobResult } from './cancel-linear-job';
export { cancelLinearJob } from './cancel-linear-job';

// Cloud agent lookup by ID (for LLM router integration)
export {
  tokenNeedsRefresh,
  refreshLinearToken,
  getValidLinearAccessToken,
} from './refresh-token';

// Job creation (for creating cloud jobs from Linear sessions)
export type {
  CreateLinearAgentJobOptions,
  CreateLinearAgentJobResult,
} from './create-linear-agent-job';
export { createLinearAgentJob } from './create-linear-agent-job';

// Elicitation fallback (for agent/workspace selection when LLM router is unavailable)
export type {
  StartElicitationFallbackOptions,
  StartElicitationFallbackResult,
  HandleElicitationResponseOptions,
  HandleElicitationResponseResult,
} from './elicitation-fallback';
export {
  startElicitationFallback,
  findPendingSelection,
  handleElicitationResponse,
  deletePendingSelection,
  parseSelection,
  stripVariationSelectors,
  stripEmojiPrefix,
} from './elicitation-fallback';

// Session comment enrichment (fetches all comments including external ones)
export { enrichSessionComments } from './enrich-session-comments';

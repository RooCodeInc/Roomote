// Types
export type {
  AgentSessionState,
  AgentSessionEventAction,
  HumanToAgentSignal,
  LinearIssue,
  LinearBrainIssue,
  LinearBrainIssuePage,
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
  ActiveLinearTaskRunResult,
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

// Active task run lookup
export {
  findActiveLinearTaskRun,
  findActiveLinearTaskRunByOrganization,
} from './find-active-linear-run';

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

// Drain pending Linear messages and create a SnapshotResume run
export type { DrainSourceRun, DrainResult } from './drain-linear-messages';
export { drainLinearMessagesToResumeRun } from './drain-linear-messages';

// Cancel task run (used when user sends stop signal)
export type { CancelLinearTaskRunResult } from './cancel-linear-run';
export { cancelLinearTaskRun } from './cancel-linear-run';

// Cloud agent lookup by ID (for LLM router integration)
export {
  tokenNeedsRefresh,
  refreshLinearToken,
  getValidLinearAccessToken,
} from './refresh-token';

// Session comment enrichment (fetches all comments including external ones)
export { enrichSessionComments } from './enrich-session-comments';

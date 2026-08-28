import { z } from 'zod';

/**
 * Linear Agent Webhook and Activity Types
 *
 * Based on Linear's Agent API documentation for AgentSessionEvent webhooks
 * and agent activity emissions.
 */

// =============================================================================
// Zod Schemas for webhook payload validation
// =============================================================================

/**
 * Linear AgentSession state schema
 */
const agentSessionStateSchema = z.enum([
  'pending',
  'thinking',
  'running',
  'completed',
  'errored',
  'paused',
  'awaiting_input',
]);

/**
 * Linear AgentSessionEvent action schema
 */
const agentSessionEventActionSchema = z.enum(['created', 'create', 'prompted']);

/**
 * Human-to-agent signal schema
 */
const humanToAgentSignalSchema = z.enum(['stop']);

/**
 * Linear Issue state schema
 */
const linearIssueStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

/**
 * Linear Issue project schema
 */
const linearIssueProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * Linear Issue team schema
 */
const linearIssueTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

/**
 * Linear Issue schema
 */
const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string(),
  branchName: z.string().optional(),
  state: linearIssueStateSchema.optional(),
  priority: z.number().optional(),
  priorityLabel: z.string().optional(),
  project: linearIssueProjectSchema.optional(),
  team: linearIssueTeamSchema.optional(),
});

/**
 * Linear Comment user schema
 */
const linearCommentUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
});

/**
 * Linear Comment schema
 * Note: url and createdAt are optional as Linear doesn't always include them
 */
const linearCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  user: linearCommentUserSchema.optional(),
});

/**
 * Linear User schema
 */
const linearUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
});

/**
 * Agent guidance schema
 */
const agentGuidanceSchema = z.object({
  system: z.string().optional(),
  instructions: z.string().optional(),
});

/**
 * AgentSession schema
 * Note: state is optional as Linear may not always include it
 */
const agentSessionSchema = z.object({
  id: z.string(),
  state: agentSessionStateSchema.optional(),
  issue: linearIssueSchema,
  comment: linearCommentSchema.optional(),
  previousComments: z.array(linearCommentSchema).optional(),
  user: linearUserSchema.optional(),
  /** The user who created/triggered this session (for task assignment/delegation) */
  creator: linearUserSchema.optional(),
  guidance: agentGuidanceSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Webhook agent activity content schema
 */
const webhookAgentActivityContentSchema = z.object({
  type: z.string(),
  body: z.string().optional(),
});

/**
 * Webhook agent activity schema
 */
const webhookAgentActivitySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  agentSessionId: z.string(),
  userId: z.string().optional(),
  content: webhookAgentActivityContentSchema,
  signal: humanToAgentSignalSchema.nullish(),
  signalMetadata: z.record(z.unknown()).nullish(),
  ephemeral: z.boolean().optional(),
});

/**
 * AgentSessionEventPayload schema - the main webhook payload
 */
export const agentSessionEventPayloadSchema = z.object({
  type: z.literal('AgentSessionEvent'),
  action: agentSessionEventActionSchema,
  organizationId: z.string(),
  appUserId: z.string(),
  agentSession: agentSessionSchema,
  webhookTimestamp: z.number(),
  webhookId: z.string(),
  agentActivity: webhookAgentActivitySchema.optional(),
});

/**
 * Parse and validate an AgentSessionEventPayload from raw JSON
 */
export function parseAgentSessionEventPayload(
  data: unknown,
):
  | { success: true; data: AgentSessionEventPayload }
  | { success: false; error: string } {
  const result = agentSessionEventPayloadSchema.safeParse(data);

  if (!result.success) {
    return {
      success: false,
      error: result.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join(', '),
    };
  }

  return { success: true, data: result.data };
}

// =============================================================================
// TypeScript Types (derived from schemas for type safety)
// =============================================================================

/**
 * Linear AgentSession state enum
 */
export type AgentSessionState =
  | 'pending'
  | 'thinking'
  | 'running'
  | 'completed'
  | 'errored'
  | 'paused'
  | 'awaiting_input';

/**
 * Linear AgentSessionEvent action types
 */
export type AgentSessionEventAction =
  | 'created' // Initial session creation (delegation or mention)
  | 'create' // Alternate form of 'created' that Linear sometimes sends
  | 'prompted'; // Follow-up prompts in the same session

/**
 * Human-to-agent signals
 * These are signals set by human users on Agent Activities of type `prompt`.
 * They provide additional context or intent that guides how an agent should
 * interpret or respond to a user's message.
 */
export type HumanToAgentSignal = 'stop'; // Instructs the agent to halt work immediately

/**
 * Agent-to-human signals
 * These are signals set by the agent on Agent Activities to provide
 * interactive elements or additional metadata.
 */
export type AgentToHumanSignal =
  | 'select' // Provides selectable options for the user
  | 'auth'; // Requires user to complete account linking

/**
 * Linear Issue from webhook payload
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  branchName?: string;
  state?: {
    id: string;
    name: string;
    type: string;
  };
  priority?: number;
  priorityLabel?: string;
  project?: {
    id: string;
    name: string;
  };
  team?: {
    id: string;
    key: string;
    name: string;
  };
}

/** Normalized issue shape used by bounded, read-only Brain collection. */
export interface LinearBrainIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  priorityLabel: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  dueDate: string | null;
  state: { name: string; type: string } | null;
  team: { key: string; name: string } | null;
  project: { name: string } | null;
  creator: { name: string } | null;
  assignee: { name: string } | null;
  labels: string[];
  comments: Array<{
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    author: string | null;
  }>;
}

export interface LinearBrainIssuePage {
  issues: LinearBrainIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

/**
 * Linear Comment from webhook payload
 * Note: url and createdAt are optional as Linear doesn't always include them
 */
export interface LinearComment {
  id: string;
  body: string;
  url?: string;
  createdAt?: string;
  user?: {
    id: string;
    name: string;
    email?: string;
  };
}

/**
 * Linear User from webhook payload
 */
export interface LinearUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Agent guidance configuration from webhook
 */
export interface AgentGuidance {
  /** System-level instructions for the agent */
  system?: string;
  /** Specific instructions for this session */
  instructions?: string;
}

/**
 * AgentSession object from webhook
 * Note: state is optional as Linear may not always include it
 */
export interface AgentSession {
  id: string;
  state?: AgentSessionState;
  issue: LinearIssue;
  /** The comment that triggered this session (for mentions) */
  comment?: LinearComment;
  /** Previous comments in the issue for context */
  previousComments?: LinearComment[];
  /** User who initiated the session */
  user?: LinearUser;
  /** The user who created/triggered this session (for task assignment/delegation) */
  creator?: LinearUser;
  /** Agent guidance/instructions */
  guidance?: AgentGuidance;
  createdAt: string;
  updatedAt: string;
}

/**
 * Content of an agent activity from a webhook
 */
export interface WebhookAgentActivityContent {
  /** The type of activity content (e.g., 'prompt' for user messages) */
  type: string;
  /** The body/text of the activity */
  body?: string;
}

/**
 * Agent activity from a webhook payload.
 * This represents activity data received in webhooks, which is different
 * from AgentActivity used for emission.
 */
export interface WebhookAgentActivity {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentSessionId: string;
  /** User who created this activity (for user prompts) */
  userId?: string;
  /** Content of the activity */
  content: WebhookAgentActivityContent;
  /**
   * Signal attached to this activity.
   * Human-to-agent signals like 'stop' are attached to prompt activities.
   * Can be null if Linear explicitly sends null instead of omitting the field.
   */
  signal?: HumanToAgentSignal | null;
  /** Additional metadata for the signal. Can be null if explicitly sent as null. */
  signalMetadata?: Record<string, unknown> | null;
  /** Whether this activity is ephemeral */
  ephemeral?: boolean;
}

/**
 * AgentSessionEvent webhook payload
 */
export interface AgentSessionEventPayload {
  type: 'AgentSessionEvent';
  action: AgentSessionEventAction;
  organizationId: string;
  appUserId: string;
  agentSession: AgentSession;
  /** Webhook delivery timestamp */
  webhookTimestamp: number;
  /** Unique webhook ID for idempotency */
  webhookId: string;
  /**
   * The agent activity that triggered this event (for 'prompted' actions).
   * Contains user prompt content and any attached signals like 'stop'.
   */
  agentActivity?: WebhookAgentActivity;
}

/**
 * Linear webhook event types we handle
 */
export type LinearWebhookPayload = AgentSessionEventPayload;

/**
 * Agent Activity Types
 * Activities are emitted by the agent to communicate progress to Linear
 */
export type AgentActivityType =
  | 'thought' // Agent's internal reasoning
  | 'action' // Agent taking an action (e.g., running a command)
  | 'response' // Agent's response to the user
  | 'error' // Error occurred
  | 'elicitation'; // Agent requesting input from user

/**
 * Agent Activity payload for emission
 *
 * Different activity types require different fields:
 * - thought, response, elicitation, error: use `content` (mapped to `body`)
 * - action: use `action`, `parameter`, and optionally `result`
 */
export interface AgentActivity {
  type: AgentActivityType;
  /** The content of the activity (for thought/response/elicitation/error types) */
  content: string;
  /** Action verb for action type activities (e.g., "Processing", "Searching") */
  action?: string;
  /** Parameter/target for action type activities (e.g., "your request") */
  parameter?: string;
  /** Result of action (optional, for completed action activities) */
  result?: string;
  /** Optional metadata for the activity */
  metadata?: Record<string, unknown>;
  /** Signal to attach to the activity (e.g., 'select' for elicitations with options) */
  signal?: AgentToHumanSignal;
  /** Additional metadata for the signal (e.g., options array for 'select' signal) */
  signalMetadata?: Record<string, unknown>;
  /** Whether this activity is ephemeral (e.g., for reasoning that should disappear) */
  ephemeral?: boolean;
}

/**
 * Agent Activity emission result
 */
export interface AgentActivityResult {
  success: boolean;
  activityId?: string;
  error?: string;
}

/**
 * Linear OAuth token response
 */
export interface LinearOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

/**
 * Result of refreshing a Linear access token
 */
export interface LinearTokenRefreshResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  error?: string;
}

/**
 * Linear viewer (authenticated user/app) info
 */
export interface LinearViewer {
  id: string;
  name: string;
  email?: string;
}

/**
 * Linear organization info
 */
export interface LinearOrganization {
  id: string;
  name: string;
  urlKey: string;
}

/**
 * Pending Linear session message for queue
 */
export interface LinearSessionMessage {
  sessionId: string;
  organizationId: string;
  action: AgentSessionEventAction;
  payload: AgentSessionEventPayload;
  userId?: string;
  timestamp: number;
}

/**
 * Result of finding an active Linear run
 */
export interface ActiveLinearTaskRunResult {
  id: number;
  status: string;
  machineId: string | null;
  taskId: string | null;
  linearSessionId: string | null;
  linearOrganizationId: string | null;
  result: unknown;
}

/**
 * Agent Plan step status - matches Linear's AgentSessionPlanStepStatus
 */
export type AgentSessionPlanStepStatus =
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'canceled';

/**
 * Agent Plan step - for native todo list display in Linear
 */
export interface AgentSessionPlanStep {
  /** Description of the task */
  content: string;
  /** Current status of the task */
  status: AgentSessionPlanStepStatus;
}

/**
 * Result of updating an agent session
 */
export interface AgentSessionUpdateResult {
  success: boolean;
  error?: string;
}

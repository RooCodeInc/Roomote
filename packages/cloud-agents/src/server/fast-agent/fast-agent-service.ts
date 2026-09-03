import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  ALL_REPOSITORIES,
  CHAT_CHANNEL_POST_TOOL_NAME,
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_CHANNELS_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  CHAT_REACTION_EMOJI_TOOL_NAME,
  FAST_EXECUTION,
  FAST_AGENT_HUMAN_FOLLOW_UP_EVENT_TYPE,
  FAST_AGENT_MEMORY_FACT_MAX_CHARS,
  INFERENCE_PROVIDER_MAX_RETRIES,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  ROOMOTE_MCP_ID,
  activeRunStatuses,
  buildInferenceProviderRecoveryPrompt,
  fastAgentHumanFollowUpEventSchema,
  formatErrorForLog,
  resolveInferenceProviderRetryDelayMs,
  isMemoryMcpServer,
  truncateAcpOutputText,
  type ReasoningEffort,
  type RunStatus,
  INTEGRATION_TOOL_LOOKUP_TRUNCATED_GUIDANCE,
  matchIntegrationTools,
  type IntegrationToolCandidate,
  CALL_INTEGRATION_TOOL_TOOL,
  FIND_INTEGRATION_TOOLS_TOOL,
} from '@roomote/types';
import {
  and,
  appendFastAgentMemory,
  asc,
  db,
  eq,
  fastAgentParentEvents,
  getDeploymentTaskModelOptions,
  getSessionForFastConversation,
  getSessionForTask,
  inArray,
  isBrainEnabled,
  isNull,
  sql,
  touchSessionActivity,
} from '@roomote/db/server';
import {
  buildFastSessionUrl,
  buildSelectedTaskSessionUrl,
} from '@roomote/communication';
import { Env } from '@roomote/env';
import { z } from 'zod';

import packageJson from '../../../../../package.json';

import { appendAttachmentTextsToPromptText } from '../../file-attachments';
import {
  buildSlackThreadPromptBlocks,
  wrapSlackMessage,
  wrapSlackThreadContext,
  type SlackThreadPromptMessage,
} from '../../utils';
import { resolveRoomoteReleaseVersion } from '../../release-version';
import {
  getAvailableEnvironments,
  type RoutableEnvironment,
} from '../available-environments';
import {
  FAST_AGENT_MODEL_ROLE,
  FAST_RESPONDING_LEASE_MS,
  FAST_RESPONDING_LEASE_RENEW_MS,
} from './fast-agent-constants';
import { buildFastAgentUserContentBlocks } from './fast-agent-content-blocks';
import { buildFastAgentSystemPrompt } from './fast-agent-prompt';
import {
  appendFastAgentVisibleMessages,
  getActiveFastAgentTasks,
  getOrCreateFastAgentSession,
  setFastAgentOpenCodeSession,
  upsertFastAgentMessage,
  type FastAgentActiveTask,
} from './fast-agent-session';
import { refreshFastAgentSessionTitle } from './fast-agent-title';
import {
  classifyNonTaskInferenceError,
  FAST_AGENT_SESSION_PERMISSIONS,
  FAST_AGENT_SESSION_TOOL_FILTER,
  generateTrackedNonTaskTextInOpenCodeSession,
  isNonTaskOpenCodePromptTimeoutError,
  isNonTaskOpenCodeSessionNotFoundError,
  isNonTaskOpenCodeSessionValidationError,
  NonTaskOpenCodePromptTimeoutError,
  NON_TASK_INFERENCE_SURFACES,
  type NonTaskPromptFile,
  type NonTaskProviderRetryEvent,
  type NonTaskOpenCodeCompletedMessage,
  type NonTaskOpenCodeAssistantMessage,
  type NonTaskOpenCodeAssistantText,
  type NonTaskOpenCodeNativeSteer,
  type NonTaskOpenCodeTaskPart,
} from '../non-task-provider-usage';
import { fastAgentOpenCodeSessionManager } from './fast-agent-opencode-session';
import {
  createFastAgentReplyStreamPublisher,
  createFastAgentReplyTextTracker,
} from './fast-agent-reply-stream';
import { createFastAgentSurfaceReplyStreamer } from './fast-agent-surface-reply-stream';
import { RemoteFastAgentSettingsSkillSource } from './fast-agent-settings-skill-source';
import { buildFastAgentExplicitSkillInvocationContext } from './fast-agent-skill-invocation';
import {
  findFastAgentUnresolvedRequest,
  INTERRUPTED_INFERENCE_RETRY_MESSAGE,
  findFastAgentActiveInferenceRetryNotice,
  markFastAgentDurableTurnDelivered,
  markFastAgentInferenceRetryNoticeInterruption,
  releaseFastAgentDurableTurnClaim,
  renewFastAgentDurableTurnClaim,
  revokeFastAgentDurableTurnReplay,
  scheduleFastAgentDurableTurnRetry,
  reconcileFastAgentInferenceRetryNotices,
  renewFastSessionRespondingLease,
  RESTARTED_ACTIVE_TURN_MESSAGE,
  type FastAgentInterruptionReason,
  type FastAgentUnresolvedRequest,
} from './fast-agent-conversation-repository';
import {
  bindFastAgentNativeToolExecutor,
  createFastAgentSpillTurnBudget,
  bindFastAgentMcpToolExecutor,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeToolRuntime,
  type FastAgentMcpToolCall,
  type FastAgentNativeToolCall,
} from './fast-agent-native-tool-bridge';
import {
  getFastAgentNativeAcpKind,
  isFastAgentNativeIntegration,
} from './fast-agent-tool-policy';
import {
  callFastAgentIntegration,
  listFastAgentIntegrations,
  type FastAgentIntegration,
} from './fast-agent-integration-broker';
import {
  cancelFastAgentTask,
  sendFastAgentTaskMessage,
} from './fast-agent-tasks';
import { getFastAgentUserIdentity } from './fast-agent-user-identity';
import { FastAgentTurnDiagnostics } from './fast-agent-turn-diagnostics';
import {
  FastAgentProcessShutdownError,
  FastAgentTurnLockLostError,
  markFastAgentShutdownCloseoutPending,
  markFastAgentShutdownCloseoutSettled,
} from './fast-agent-turn-lock';
import {
  captureFastAgentInferenceAttemptOutcome,
  captureFastAgentInferenceContext,
  type FastAgentPromptKind,
} from './fast-agent-context-telemetry';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import { FastAgentSkillStore } from './fast-agent-skill-store';
import {
  FAST_AGENT_REACTION_INPUT_TYPE,
  type FastAgentConversation,
  type FastAgentHumanInput,
  type FastAgentInputPreset,
  isFastAgentCommunicationConversation,
  type FastAgentPlatformEventHandling,
  type FastAgentPlatformEventKind,
  type FastAgentPlatformEventVisibility,
  type FastAgentReply,
  type FastAgentReplyHandle,
  type FastAgentTurnAdapter,
  type FastAgentTurnSource,
} from './fast-agent-conversation';
import { prepareShowWidget } from '../show-widget';

const LEGACY_SLACK_REACTION_TOOL = 'add_reaction_to_slack_message';

function selectFastRoomoteChannelTools(options: {
  integrations: FastAgentIntegration[];
  conversation: FastAgentConversation;
  currentMessageReactable: boolean;
}): FastAgentIntegration[] {
  const slackConversation = options.conversation.surface === 'slack';
  return options.integrations.map((integration) =>
    integration.id === ROOMOTE_MCP_ID
      ? {
          ...integration,
          tools: integration.tools.filter(({ name }) => {
            if (name === LEGACY_SLACK_REACTION_TOOL) return false;
            if (
              name === CHAT_CHANNELS_TOOL.name ||
              name === CHAT_CHANNEL_POST_TOOL_NAME
            ) {
              return slackConversation;
            }
            if (name === CHAT_REACTION_EMOJI_TOOL_NAME) {
              return slackConversation && options.currentMessageReactable;
            }
            return true;
          }),
        }
      : integration,
  );
}

export type FastAgentThreadMessage = SlackThreadPromptMessage;

const chatReplyArgsSchema = z.object({
  /** Omitted when the reply is the assistant text written before the call. */
  message: z.string().trim().min(1).optional(),
  purpose: z.enum(['ack', 'progress', 'closeout', 'clarification']),
  imageArtifactIds: z.array(z.string()).optional(),
  suggestions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(140),
        brief: z.string().trim().min(1).max(2000),
        environmentId: z.string().trim().min(1).optional(),
      }),
    )
    .max(10)
    .optional(),
});
const chatReactionArgsSchema = z.object({
  name: z.string().trim().min(1),
  purpose: z.enum(['ack', 'closeout']),
});
const showWidgetArgsSchema = z.object({
  html: z.string(),
  title: z.string().optional(),
  css: z.string().optional(),
  height: z.number().optional(),
  textFallback: z.string().optional(),
});
const createArtifactArgsSchema = z.object({
  path: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(131_072),
  contentType: z.string().trim().min(1).max(200).optional(),
  artifactType: z.enum(['general', 'plan']).optional().default('general'),
});
const FAST_AGENT_DEFAULT_SLACK_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// A reply tool call without a message reads the text the model wrote before
// it. That text arrives on the OpenCode event stream, which may trail the
// tool bridge request by a few milliseconds; bound how long to wait for it.
const FAST_AGENT_REPLY_TEXT_SETTLE_TIMEOUT_MS = 750;
const FAST_AGENT_REPLY_TEXT_SETTLE_POLL_MS = 25;
const FAST_AGENT_EMPTY_REPLY_ERROR =
  'Write the reply as assistant text before calling send_chat_reply, or pass it as "message".';
const FAST_AGENT_CANONICAL_TOOL_OUTPUT_MAX_CHARS = 50_000;
const FAST_AGENT_HUMAN_STEER_MAX_MESSAGES = 16;
const FAST_AGENT_HUMAN_STEER_QUERY_LIMIT =
  FAST_AGENT_HUMAN_STEER_MAX_MESSAGES + 1;
const FAST_AGENT_HUMAN_STEER_MAX_TEXT_BYTES = 64 * 1024;
const FAST_AGENT_HUMAN_STEER_MAX_FILES = 16;
const FAST_AGENT_HUMAN_STEER_MAX_FILE_BYTES = 24 * 1024 * 1024;

function buildFastAgentNativeSteerMessageId(
  rowId: string,
  createdAt: Date,
): string {
  const sortable =
    (BigInt(createdAt.getTime()) * BigInt(0x1000)) &
    ((BigInt(1) << BigInt(48)) - BigInt(1));
  const suffix = rowId.replaceAll('-', '').slice(0, 14);
  return `msg_${sortable.toString(16).padStart(12, '0')}${suffix}`;
}

async function getPendingFastAgentHumanFollowUps(
  sessionId: string,
  excludedEventId?: string,
) {
  return db.query.fastAgentParentEvents.findMany({
    where: and(
      eq(fastAgentParentEvents.conversationId, sessionId),
      isNull(fastAgentParentEvents.deliveredAt),
      isNull(fastAgentParentEvents.discardedAt),
      // An inline-admitted row is a whole turn owned by a live process (or
      // awaiting queue resumption), never a steer for the current turn.
      isNull(fastAgentParentEvents.admission),
      sql`${fastAgentParentEvents.event} ->> 'type' = ${FAST_AGENT_HUMAN_FOLLOW_UP_EVENT_TYPE}`,
      ...(excludedEventId
        ? [
            sql`${fastAgentParentEvents.event} ->> 'eventId' <> ${excludedEventId}`,
          ]
        : []),
    ),
    orderBy: [
      asc(fastAgentParentEvents.createdAt),
      asc(fastAgentParentEvents.id),
    ],
    limit: FAST_AGENT_HUMAN_STEER_QUERY_LIMIT,
  });
}

async function markFastAgentHumanFollowUpsDelivered(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;

  await db
    .update(fastAgentParentEvents)
    .set({ deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(
      and(
        inArray(fastAgentParentEvents.id, ids),
        isNull(fastAgentParentEvents.deliveredAt),
        isNull(fastAgentParentEvents.discardedAt),
      ),
    );
}

async function setFastSessionResponding(
  fastConversationId: string,
  responding: boolean,
  /** Re-checked after the session lookup, immediately before the write, so
   * an owner fenced off mid-lookup cannot extend a successor's lease. */
  isOwnershipCurrent?: () => boolean,
): Promise<void> {
  const session = await getSessionForFastConversation(db, fastConversationId);
  if (!session) return;
  if (isOwnershipCurrent && !isOwnershipCurrent()) return;
  await touchSessionActivity(db, session.id, Math.floor(Date.now() / 1000), {
    respondingUntil: responding
      ? new Date(Date.now() + FAST_RESPONDING_LEASE_MS)
      : null,
  });
}

function buildFastAgentTurnId({
  currentMessageId,
  conversation,
  question,
}: {
  currentMessageId?: string;
  conversation: FastAgentConversation;
  question: string;
}): string {
  if (currentMessageId) return currentMessageId;

  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        conversation.surface,
        conversation.workspaceId,
        conversation.conversationId,
        question,
      ]),
    )
    .digest('hex')
    .slice(0, 24);
  return `fallback:${digest}`;
}

function serializeFastAgentToolOutput(result: unknown): {
  output: string;
  truncated: boolean;
} {
  const output = stringifyFastAgentToolOutput(result);

  const { text, truncation } = truncateAcpOutputText(
    output,
    FAST_AGENT_CANONICAL_TOOL_OUTPUT_MAX_CHARS,
  );
  return { output: text, truncated: truncation !== null };
}

function stringifyFastAgentToolOutput(result: unknown): string {
  let output: string;
  try {
    output = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    output = String(result);
  }
  return output;
}

function getFastAgentDefaultSlackHistoryOldest(latest?: string): string {
  const numericLatest =
    latest && /^\d+(?:\.\d+)?$/.test(latest) ? Number(latest) : Number.NaN;
  const latestMs = Number.isFinite(numericLatest)
    ? numericLatest * 1000
    : latest
      ? Date.parse(latest)
      : Date.now();

  return new Date(
    (Number.isFinite(latestMs) ? latestMs : Date.now()) -
      FAST_AGENT_DEFAULT_SLACK_HISTORY_LOOKBACK_MS,
  ).toISOString();
}
const launchTaskArgsSchema = z.object({
  prompt: z.string().trim().min(1),
  environmentId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  includeAttachments: z.boolean().optional().default(false),
  kickoffMessage: z.string().trim().min(1),
});
const taskMessageArgsSchema = z.object({
  taskId: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1),
  includeAttachments: z.boolean().optional().default(false),
});
const taskIdArgsSchema = z.object({
  taskId: z.string().trim().min(1).nullable().optional(),
});
const ignoreEventArgsSchema = z.object({ reason: z.string().trim().min(1) });
const findIntegrationToolsArgsSchema = z.object(
  FIND_INTEGRATION_TOOLS_TOOL.inputSchema,
);
const callIntegrationToolArgsSchema = z.object(
  CALL_INTEGRATION_TOOL_TOOL.inputSchema,
);

/**
 * Resolve on-demand integration tools for `find_integration_tools` from the
 * in-memory catalog; matching and ranking are shared with task sandboxes.
 */
function findFastAgentIntegrationTools(
  integrations: FastAgentIntegration[],
  args: z.infer<typeof findIntegrationToolsArgsSchema>,
): {
  tools: IntegrationToolCandidate[];
  truncated: boolean;
  unknownIntegration: boolean;
} {
  if (
    args.integrationId &&
    !integrations.some((integration) => integration.id === args.integrationId)
  ) {
    return { tools: [], truncated: false, unknownIntegration: true };
  }
  const candidates = integrations.flatMap((integration) =>
    integration.tools.map((tool) => ({
      integrationId: integration.id,
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined
        ? { inputSchema: tool.inputSchema }
        : {}),
    })),
  );
  return {
    ...matchIntegrationTools(candidates, args),
    unknownIntegration: false,
  };
}
const saveMemoryArgsSchema = z.object({
  memory: z.string().trim().min(1).max(FAST_AGENT_MEMORY_FACT_MAX_CHARS),
});
const requestUserInputQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  header: z.string().trim().min(1).max(60),
  question: z.string().trim().min(1).max(500),
  isOther: z.boolean().optional().default(false),
  isSecret: z.boolean().optional().default(false),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(140),
        description: z.string().trim().min(1).max(500),
      }),
    )
    .min(1)
    .max(12)
    .optional(),
  multiple: z.boolean().optional(),
});
const fastAgentInputPresetSchema = z.enum(['setup_starter_tasks']);
// Some models fill every optional tool parameter, so a trusted preset may
// arrive alongside placeholder questions. The preset wins: its questions are
// server-supplied and model-provided ones are discarded rather than rejected.
const requestUserInputArgsSchema = z
  .object({
    questions: z.array(requestUserInputQuestionSchema).min(1).max(4).optional(),
    preset: fastAgentInputPresetSchema.optional(),
  })
  .transform(
    (
      args,
    ):
      | { preset: FastAgentInputPreset }
      | { questions: z.output<typeof requestUserInputQuestionSchema>[] }
      | null =>
      args.preset
        ? { preset: args.preset }
        : args.questions
          ? { questions: args.questions }
          : null,
  );

function normalizeThreadText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function canonicalizeIntegrationCallValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeIntegrationCallValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [
          key,
          canonicalizeIntegrationCallValue(nestedValue),
        ]),
    );
  }
  return value;
}

function buildIntegrationCallSignature({
  integrationId,
  toolName,
  args,
}: {
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return JSON.stringify([
    integrationId,
    toolName,
    canonicalizeIntegrationCallValue(args),
  ]);
}

const REPLAY_SAFE_ROOMOTE_TASK_ACTIONS = new Set([
  'search',
  'get_summary',
  'get_messages',
  'search_tasks',
  'get_compute_logs',
  'list_environments',
]);

const REPLAY_SAFE_ROOMOTE_AUTOMATION_ACTIONS = new Set([
  'list',
  'list_models',
  'resolve_schedule',
]);

/**
 * Whether re-running the turn from scratch after this call could duplicate
 * an external effect. Reads and presentation-only calls are safe; anything
 * that launches, messages, cancels, mutates, or reaches an integration whose
 * semantics are unknown is not.
 */
function isReplaySafeFastAgentMcpCall(call: FastAgentMcpToolCall): boolean {
  if (call.integrationId !== ROOMOTE_MCP_ID) return false;
  if (
    call.toolName === 'get_about_me' ||
    call.toolName === CHAT_CHANNELS_TOOL.name ||
    call.toolName === CHAT_CHANNEL_MESSAGES_TOOL.name ||
    call.toolName === CHAT_MESSAGE_CONTEXT_TOOL.name
  ) {
    return true;
  }
  if (call.toolName === 'manage_tasks') {
    return (
      typeof call.args.action === 'string' &&
      REPLAY_SAFE_ROOMOTE_TASK_ACTIONS.has(call.args.action)
    );
  }
  if (call.toolName === MANAGE_CUSTOM_AUTOMATIONS_TOOL.name) {
    return (
      typeof call.args.action === 'string' &&
      REPLAY_SAFE_ROOMOTE_AUTOMATION_ACTIONS.has(call.args.action)
    );
  }
  return false;
}

function isReplaySafeFastAgentNativeTool(
  call: FastAgentNativeToolCall,
): boolean {
  switch (call.name) {
    // An acknowledgement or progress note may repeat on resume (the resumed
    // turn is told not to re-acknowledge); a closeout ends the turn, so a
    // replay after it would answer twice.
    case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply:
      return call.args.purpose !== 'closeout';
    case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction:
    case FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent:
    case FAST_AGENT_NATIVE_TOOL_NAMES.listSkills:
    case FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill:
    case FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep:
    case FAST_AGENT_NATIVE_TOOL_NAMES.spillRead:
      return true;
    default:
      return false;
  }
}

export const FAST_AGENT_INFERENCE_MAX_RETRIES = INFERENCE_PROVIDER_MAX_RETRIES;
export const FAST_AGENT_TRANSIENT_INFERENCE_MAX_RETRIES = 6;
// Matches the standard-task recovery delay ceiling so a single Fast failure
// burst gets a comparable bounded backoff window (~63-76s with jitter).
const FAST_AGENT_RETRYABLE_INFERENCE_MAX_DELAY_MS = 60_000;
// Recoveries shorter than this stay silent, like standard-task recovery that
// never posts retry chatter to the user's chat surface. A notice appears only
// when the user is about to wait longer than this without any progress.
const FAST_AGENT_SILENT_RECOVERY_WINDOW_MS = 30_000;
// Progress-based budget resets are bounded so one turn cannot retry forever:
// this caps total automatic retries across every reset within a single turn.
export const FAST_AGENT_MAX_INFERENCE_RETRIES_PER_TURN = 12;
// Durable retry scheduling: a replay-safe turn parks instead of waiting out
// provider backoff in process. Parks keep going for a wall-clock horizon
// measured from the first failure (a real outage is meant to be ridden out,
// not given up on), with a safety cap on handoffs since every park re-prompts
// from scratch. The first short in-process retry stays in place: a one-off
// blip is cheapest to absorb where it happened.
export const FAST_AGENT_DURABLE_RETRY_HORIZON_MS = 15 * 60_000;
export const FAST_AGENT_DURABLE_RETRY_MAX_PARKS = 30;
const FAST_AGENT_DURABLE_RETRY_IMMEDIATE_PARK_WAIT_MS = 10_000;
const FAST_AGENT_DURABLE_RETRY_PARK_BASE_DELAY_MS = 2_000;
const FAST_AGENT_DURABLE_RETRY_PARK_MAX_DELAY_MS = 60_000;
const FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const FAST_AGENT_TRANSIENT_RETRY_JITTER_RATIO = 0.2;
const FAST_AGENT_PROVIDER_RECOVERY_PROMPT =
  buildInferenceProviderRecoveryPrompt({ protectCompletedSideEffects: true });

type FastAgentInferenceFailure = ReturnType<
  typeof classifyNonTaskInferenceError
>;

type FastAgentInferenceRetryNotice = {
  failure: FastAgentInferenceFailure;
  attemptNumber: number;
  maxAttempts?: number;
  delayMs?: number;
};

type FastAgentInferenceRetryOptions = {
  canRetry?: (error: unknown, failure: FastAgentInferenceFailure) => boolean;
  prepareRetry?: () => Promise<void> | void;
  /**
   * Offered the pending backoff after its notice is recorded and before the
   * process would sleep it out. Returning true means the wait now belongs to
   * durable scheduling and this execution must stop without an outcome; the
   * loop then throws FastAgentDurableRetryScheduledError.
   */
  deferRetry?: (
    notice: FastAgentInferenceRetryNotice & { inProcessAttempt: number },
  ) => Promise<Date | null>;
  /**
   * Consume forward progress made since the previous failure. Returning true
   * grants a fresh bounded retry budget, mirroring how standard-task provider
   * recovery resets after every completed turn. Callers must only return true
   * when the next retry continues the same session, so completed side effects
   * are never replayed with the refreshed budget.
   */
  consumeRetryBudgetReset?: () => boolean;
  signal?: AbortSignal;
};

/**
 * Abort reason for the OpenCode prompt once the turn has delivered its
 * closeout. Any further model request would only produce post-closeout text
 * that is never shown, while holding the conversation's turn lock.
 */
class FastAgentTurnClosedError extends Error {
  constructor() {
    super('The Fast turn delivered its closeout.');
    this.name = 'FastAgentTurnClosedError';
  }
}

/**
 * Thrown out of a turn whose pending inference retry was parked durably: the
 * queue re-runs the same turn at the scheduled time, so this execution ends
 * with no user-visible outcome and no settlement of its own.
 */
export class FastAgentDurableRetryScheduledError extends Error {
  constructor(public readonly retryAt: Date) {
    super(
      `Fast turn parked for a durable inference retry at ${retryAt.toISOString()}.`,
    );
    this.name = 'FastAgentDurableRetryScheduledError';
  }
}

/**
 * Find a park signal inside an error chain: an aborted OpenCode prompt may
 * surface the abort reason wrapped as a prompt error's cause.
 */
export function findFastAgentDurableRetryScheduledError(
  error: unknown,
): FastAgentDurableRetryScheduledError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof FastAgentDurableRetryScheduledError) return current;
    if (typeof current !== 'object') return null;
    const record = current as { cause?: unknown; providerError?: unknown };
    current = record.cause ?? record.providerError;
  }
  return null;
}

class FastAgentInferenceError extends Error {
  constructor(
    public readonly failure: FastAgentInferenceFailure,
    cause: unknown,
  ) {
    super(
      `Fast mode inference failed (${failure.reason}): ${formatErrorForLog(cause)}`,
      { cause },
    );
    this.name = 'FastAgentInferenceError';
  }
}

function resolveFastAgentInferenceMaxRetries(
  failure: FastAgentInferenceFailure,
): number {
  // Rate limits keep the shared Retry-After governed budget. Every other
  // retryable failure gets the standard-task-sized budget so Fast stops
  // giving up on transient provider errors that coding tasks recover from.
  return failure.reason === 'rate_limited'
    ? FAST_AGENT_INFERENCE_MAX_RETRIES
    : FAST_AGENT_TRANSIENT_INFERENCE_MAX_RETRIES;
}

function resolveFastAgentInferenceRetryDelayMs(
  error: unknown,
  failure: FastAgentInferenceFailure,
  retryNumber: number,
): number {
  const rateLimited = failure.reason === 'rate_limited';
  const delayMs = resolveInferenceProviderRetryDelayMs({
    error,
    attemptNumber: retryNumber,
    rateLimited,
    ...(rateLimited
      ? {}
      : { maxDelayMs: FAST_AGENT_RETRYABLE_INFERENCE_MAX_DELAY_MS }),
  });

  if (rateLimited) {
    return delayMs;
  }

  // Positive jitter spreads concurrent recovery attempts without shortening
  // the base backoff window. Six retries remain bounded below 76 seconds.
  return Math.round(
    delayMs * (1 + Math.random() * FAST_AGENT_TRANSIENT_RETRY_JITTER_RATIO),
  );
}

function formatFastAgentInferenceRetryNotice(
  notice: FastAgentInferenceRetryNotice,
): string {
  const headline =
    notice.failure.reason === 'rate_limited'
      ? 'The inference provider is rate limiting requests.'
      : notice.failure.reason === 'gateway_blocked'
        ? 'Having trouble reaching the inference provider.'
        : notice.failure.reason === 'timeout'
          ? 'The inference provider did not respond in time.'
          : 'The inference provider returned a temporary error.';

  if (notice.delayMs === undefined || notice.maxAttempts === undefined) {
    return `${headline} Retrying automatically…`;
  }

  const seconds = Math.max(1, Math.round(notice.delayMs / 1_000));
  return `${headline} Retrying in ${seconds}s (attempt ${notice.attemptNumber}/${notice.maxAttempts}).`;
}

function formatFastAgentInferenceFailure(
  failure: FastAgentInferenceFailure,
  retried: boolean,
): string {
  switch (failure.reason) {
    case 'content_filter':
      return 'The inference provider blocked this response with its content filter, so retrying will not help. Try rephrasing the request or asking in a new thread.';
    case 'rate_limited':
      return retried
        ? 'The inference provider is still rate limiting requests after retrying. Any delegated tasks can keep running; please try again when provider capacity is available.'
        : 'The inference provider is rate limiting requests. Any delegated tasks can keep running; please try again when provider capacity is available.';
    case 'timeout':
      return retried
        ? 'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.'
        : 'The inference provider did not respond. Any delegated tasks can keep running; please try again in a moment.';
    case 'endpoint_unreachable':
      return retried
        ? 'Could not reach the inference provider after retrying. Please try again in a moment.'
        : 'Could not reach the inference provider. Please try again in a moment.';
    case 'gateway_blocked':
      return retried
        ? 'The request is still being blocked by the inference provider gateway after retrying. Please try again in a moment.'
        : 'The request was blocked by the inference provider gateway. Please try again in a moment.';
    case 'insufficient_credits':
      return 'The inference provider account has insufficient credits or quota.';
    case 'invalid_credentials':
      return 'Could not authenticate with the configured inference provider. An administrator needs to reconnect or replace its credentials.';
    case 'model_unavailable':
      return 'The configured model is not available from the inference provider. An administrator needs to select an available model.';
    default:
      return 'Could not complete the request because the inference provider returned an error. Please try again in a moment.';
  }
}

function waitForFastAgentInferenceRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('The inference retry was aborted.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runFastAgentInferenceWithRetries<T>(
  run: () => Promise<T>,
  onRetry?: (notice: FastAgentInferenceRetryNotice) => Promise<void>,
  options: FastAgentInferenceRetryOptions = {},
): Promise<T> {
  let totalRetryCount = 0;
  for (let retryNumber = 0; ; retryNumber += 1) {
    try {
      options.signal?.throwIfAborted();
      return await run();
    } catch (error) {
      // A prompt aborted because the turn parked itself on OpenCode's own
      // provider backoff is not a failure to classify or retry here.
      const parked = findFastAgentDurableRetryScheduledError(error);
      if (parked) throw parked;
      // Session loss is the session manager's bootstrap signal, not a
      // provider failure this loop should absorb.
      if (isNonTaskOpenCodeSessionNotFoundError(error)) {
        throw error;
      }

      const failure = classifyNonTaskInferenceError(error);
      if (
        failure.retryable &&
        totalRetryCount < FAST_AGENT_MAX_INFERENCE_RETRIES_PER_TURN &&
        options.consumeRetryBudgetReset?.() === true
      ) {
        // The failed attempt made real forward progress that the next warm
        // continuation preserves, so grant a fresh bounded budget the same
        // way standard-task recovery resets after each completed turn.
        retryNumber = 0;
      }
      const maxRetries = resolveFastAgentInferenceMaxRetries(failure);
      if (
        !failure.retryable ||
        options.canRetry?.(error, failure) === false ||
        retryNumber >= maxRetries ||
        totalRetryCount >= FAST_AGENT_MAX_INFERENCE_RETRIES_PER_TURN
      ) {
        throw new FastAgentInferenceError(failure, error);
      }

      totalRetryCount += 1;
      const attemptNumber = retryNumber + 1;
      const delayMs = resolveFastAgentInferenceRetryDelayMs(
        error,
        failure,
        attemptNumber,
      );
      try {
        await onRetry?.({
          failure,
          attemptNumber,
          maxAttempts: maxRetries,
          delayMs,
        });
      } catch (noticeError) {
        console.warn(
          `[Fast Agent] Failed to post inference retry notice: ${formatErrorForLog(noticeError)}`,
        );
      }
      // The notice is recorded first so a resumed run can find and keep
      // editing it; only then may the wait leave this process.
      const parkedUntil = await options.deferRetry?.({
        failure,
        attemptNumber,
        maxAttempts: maxRetries,
        delayMs,
        inProcessAttempt: attemptNumber,
      });
      if (parkedUntil) {
        throw new FastAgentDurableRetryScheduledError(parkedUntil);
      }
      await options.prepareRetry?.();
      await waitForFastAgentInferenceRetry(delayMs, options.signal);
    }
  }

  throw new Error('Fast mode exhausted its inference retry loop.');
}

function buildUserTextMessage(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function buildAssistantTextMessage(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function getFastAgentImageFiles(images: string[]): NonTaskPromptFile[] {
  return images.flatMap((image) => {
    const url = image.trim();
    const mime = /^data:(image\/[^;,]+);base64,/i.exec(url)?.[1];
    return mime ? [{ mime, url }] : [];
  });
}

function extractModelMessageText(message: ModelMessage): string[] {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return [];
  }
  if (typeof message.content === 'string') {
    return [message.content];
  }
  return message.content.flatMap((part) =>
    part.type === 'text' ? [part.text] : [],
  );
}

function buildSupplementalThreadContext({
  threadContext,
  compatibilityMessages,
  currentMessageTs,
  surface,
}: {
  threadContext: FastAgentThreadMessage[];
  compatibilityMessages: ModelMessage[];
  currentMessageTs?: string;
  surface: FastAgentConversation['surface'];
}): string | undefined {
  const persistedMessageCounts = new Map<string, number>();
  for (const message of compatibilityMessages) {
    for (const text of extractModelMessageText(message)) {
      const normalizedText = normalizeThreadText(text);
      if (!normalizedText) continue;
      const key = `${message.role}:${normalizedText}`;
      persistedMessageCounts.set(
        key,
        (persistedMessageCounts.get(key) ?? 0) + 1,
      );
    }
  }

  const supplementalMessages = threadContext.filter((message) => {
    const normalizedText = normalizeThreadText(message.text);
    if (!normalizedText || message.ts === currentMessageTs) {
      return false;
    }
    const key = `${message.bot_id ? 'assistant' : 'user'}:${normalizedText}`;
    const remaining = persistedMessageCounts.get(key) ?? 0;
    if (remaining > 0) {
      persistedMessageCounts.set(key, remaining - 1);
      return false;
    }
    return true;
  });

  const text =
    surface === 'slack'
      ? wrapSlackThreadContext(
          supplementalMessages.map((message) => ({
            displayName: message.username?.trim() || message.user,
            text: message.text,
            ts: message.ts,
          })),
        )
      : wrapFastAgentThreadContext(supplementalMessages);

  return text;
}

function wrapFastAgentMessage(
  text: string,
  sender?: { displayName?: string; githubLogin?: string },
  agentContext?: string,
): string {
  // Surface context (a Linear issue, a pull request, auto-respond channel
  // instructions) travels beside the message on every surface, the way the
  // Slack envelope carries it.
  const normalizedAgentContext = agentContext?.trim();
  const contextBlock = normalizedAgentContext
    ? `<current_message_context>\n${escapeFastAgentEnvelopeText(normalizedAgentContext)}\n</current_message_context>\n\n`
    : '';
  return `${contextBlock}<current_message>\n${escapeFastAgentEnvelopeJson({
    ...(sender?.displayName ? { sender_name: sender.displayName } : {}),
    ...(sender?.githubLogin ? { sender_github: sender.githubLogin } : {}),
    text,
  })}\n</current_message>`;
}

function escapeFastAgentEnvelopeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeFastAgentEnvelopeJson(value: Record<string, string>): string {
  return JSON.stringify(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const UNRESOLVED_REQUEST_TEXT_MAX_CHARS = 2_000;
const FAST_AGENT_RESUMED_TURN_MARKER =
  '<resumed_turn>A service restart interrupted the previous attempt at this request before it finished.</resumed_turn>';
const FAST_AGENT_RESUMED_RETRY_TURN_MARKER =
  '<resumed_turn>The previous attempt at this request failed with a temporary inference provider error and is being retried automatically.</resumed_turn>';

function wrapFastAgentUnresolvedRequest(
  request: FastAgentUnresolvedRequest,
): string {
  const text =
    request.text.length > UNRESOLVED_REQUEST_TEXT_MAX_CHARS
      ? `${request.text.slice(0, UNRESOLVED_REQUEST_TEXT_MAX_CHARS)}…`
      : request.text;
  return `<unresolved_request>\n${escapeFastAgentEnvelopeJson({
    reason: request.reason,
    text,
  })}\n</unresolved_request>`;
}

function wrapFastAgentThreadContext(
  threadContext: FastAgentThreadMessage[],
): string | undefined {
  const messages = threadContext.flatMap((message) => {
    const text = normalizeThreadText(message.text);
    if (!text) return [];
    return [
      escapeFastAgentEnvelopeJson({
        sender_name: message.username?.trim() || message.user,
        message_id: message.ts,
        text,
      }),
    ];
  });

  return messages.length > 0
    ? `<thread_context>\n${messages.join('\n')}\n</thread_context>`
    : undefined;
}

function buildFastAgentMessages({
  question,
  currentMessageAgentContext,
  threadContext,
  compatibilityMessages,
  currentMessageTs,
  currentMessageSender,
  surface,
  reactionInput,
  turnSource,
  slackRoomoteUserId,
  unresolvedRequest,
  resumedAfterInterruption = false,
  resumedAfterInferenceRetry = false,
}: {
  question: string;
  currentMessageAgentContext?: string;
  threadContext: FastAgentThreadMessage[];
  compatibilityMessages: ModelMessage[];
  currentMessageTs?: string;
  currentMessageSender?: {
    slackUserId?: string;
    displayName?: string;
    githubLogin?: string;
  };
  surface: FastAgentConversation['surface'];
  reactionInput: boolean;
  turnSource: FastAgentTurnSource;
  slackRoomoteUserId?: string;
  unresolvedRequest?: FastAgentUnresolvedRequest | null;
  resumedAfterInterruption?: boolean;
  resumedAfterInferenceRetry?: boolean;
}): {
  bootstrapMessages: ModelMessage[];
  turnMessages: ModelMessage[];
  bootstrapThreadContextPresent: boolean;
  turnThreadContextPresent: boolean;
} {
  const normalizedQuestion = normalizeThreadText(question);
  const explicitSkillInvocationContext =
    turnSource === 'human' && !reactionInput
      ? buildFastAgentExplicitSkillInvocationContext(
          question,
          surface,
          slackRoomoteUserId,
        )
      : undefined;
  const contextualMessageTs = reactionInput ? undefined : currentMessageTs;
  const wrappedCurrentUserMessageText = reactionInput
    ? normalizedQuestion
    : surface === 'slack'
      ? currentMessageTs
        ? wrapSlackMessage(normalizedQuestion, {
            ts: currentMessageTs,
            senderSlackId: currentMessageSender?.slackUserId,
            senderName: currentMessageSender?.displayName,
            senderGithub: currentMessageSender?.githubLogin,
            agentContext: currentMessageAgentContext,
          })
        : normalizedQuestion
      : turnSource === 'human'
        ? wrapFastAgentMessage(
            normalizedQuestion,
            currentMessageSender,
            currentMessageAgentContext,
          )
        : normalizedQuestion;
  const currentUserMessageText = [
    explicitSkillInvocationContext,
    wrappedCurrentUserMessageText,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');
  const turnMessage = buildUserTextMessage(currentUserMessageText);
  // The envelope travels with the turn delta (not only the bootstrap) so a
  // warm session also learns that the previous request is still owed.
  const unresolvedRequestText = unresolvedRequest
    ? wrapFastAgentUnresolvedRequest(unresolvedRequest)
    : undefined;
  const resumedTurnText = resumedAfterInterruption
    ? FAST_AGENT_RESUMED_TURN_MARKER
    : resumedAfterInferenceRetry
      ? FAST_AGENT_RESUMED_RETRY_TURN_MARKER
      : undefined;

  if (compatibilityMessages.length > 0) {
    const supplementalThreadContext = buildSupplementalThreadContext({
      threadContext,
      compatibilityMessages,
      currentMessageTs: contextualMessageTs,
      surface,
    });
    const turnMessages = [
      ...(supplementalThreadContext
        ? [buildUserTextMessage(supplementalThreadContext)]
        : []),
      ...(unresolvedRequestText
        ? [buildUserTextMessage(unresolvedRequestText)]
        : []),
      ...(resumedTurnText ? [buildUserTextMessage(resumedTurnText)] : []),
      turnMessage,
    ];
    return {
      bootstrapMessages: [...compatibilityMessages, ...turnMessages],
      turnMessages,
      bootstrapThreadContextPresent: Boolean(supplementalThreadContext),
      turnThreadContextPresent: Boolean(supplementalThreadContext),
    };
  }

  const { threadContext: serializedThreadContext, replyingTo } =
    contextualMessageTs && surface === 'slack'
      ? buildSlackThreadPromptBlocks({
          threadMessages: threadContext,
          currentMessageTs: contextualMessageTs,
        })
      : {
          threadContext: wrapFastAgentThreadContext(threadContext),
          replyingTo: undefined,
        };
  const bootstrapText = [
    serializedThreadContext,
    replyingTo,
    unresolvedRequestText,
    resumedTurnText,
    currentUserMessageText,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');
  return {
    bootstrapMessages: [buildUserTextMessage(bootstrapText)],
    turnMessages: [
      ...(unresolvedRequestText
        ? [buildUserTextMessage(unresolvedRequestText)]
        : []),
      ...(resumedTurnText ? [buildUserTextMessage(resumedTurnText)] : []),
      turnMessage,
    ],
    bootstrapThreadContextPresent: Boolean(serializedThreadContext),
    turnThreadContextPresent: false,
  };
}

function serializeFastAgentMessages(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content
            .map((part) =>
              part.type === 'text'
                ? part.text
                : `[${part.type} attachment omitted]`,
            )
            .join('\n')
        : String(message.content);
      return `[${message.role.toUpperCase()}]\n${content}`;
    })
    .join('\n\n');
}

function selectActiveTaskId(
  requestedTaskId: string | null | undefined,
  activeTasks: Map<string, FastAgentActiveTask>,
): { taskId?: string; error?: string } {
  if (activeTasks.size === 0) {
    return { error: 'There is no active or resumable delegated task.' };
  }
  const taskId =
    requestedTaskId ??
    (activeTasks.size === 1 ? activeTasks.keys().next().value : undefined);
  if (!taskId) {
    return {
      error:
        'Multiple delegated tasks are available. Ask the user which task they mean.',
    };
  }
  if (!activeTasks.has(taskId)) {
    return {
      error: `Task ${taskId} is not active or resumable in this conversation.`,
    };
  }
  return { taskId };
}

function toolFailure(error: unknown): { success: false; error: string } {
  return { success: false, error: formatErrorForLog(error) };
}

function isSuccessfulChatReactionResult(
  result: unknown,
): result is { channelId: string; messageTs: string; name: string } {
  if (!result || typeof result !== 'object') return false;
  const value = result as Record<string, unknown>;
  return (
    typeof value.channelId === 'string' &&
    typeof value.messageTs === 'string' &&
    typeof value.name === 'string'
  );
}

export async function answerFastAgentQuestion({
  question,
  images = [],
  attachmentTexts = [],
  currentMessageAgentContext,
  threadContext = [],
  userId,
  apiBaseUrl,
  conversation,
  currentMessageId,
  senderDisplayName,
  senderExternalId,
  activeTasks = [],
  adapter,
  signal,
  model,
  reasoningEffort,
  turnSource = 'human',
  input,
  platformEventHandling = 'default',
  platformEventVisibility = 'optional',
  platformEventKind = 'delegated_task',
  allowSilentAmbientReply = false,
  platformEventTranscriptPayload,
  slackRoomoteUserId,
  currentDurableHumanFollowUpEventId,
  setupSnapshot,
  setupSession = false,
  durableAdmission,
  resumedAfterInterruption = false,
  resumedAfterInferenceRetry = false,
}: {
  question: string;
  images?: string[];
  attachmentTexts?: string[];
  currentMessageAgentContext?: string;
  threadContext?: FastAgentThreadMessage[];
  userId: string;
  apiBaseUrl?: string;
  conversation: FastAgentConversation;
  currentMessageId?: string;
  senderDisplayName?: string;
  senderExternalId?: string;
  activeTasks?: FastAgentActiveTask[];
  adapter: FastAgentTurnAdapter;
  signal?: AbortSignal;
  /** Explicit model override for this turn; defaults to the deployment's
   * orchestration model. */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  turnSource?: FastAgentTurnSource;
  input?: FastAgentHumanInput;
  platformEventHandling?: FastAgentPlatformEventHandling;
  platformEventVisibility?: FastAgentPlatformEventVisibility;
  platformEventKind?: FastAgentPlatformEventKind;
  /** True only for an unmentioned turn in a multi-human Fast conversation. */
  allowSilentAmbientReply?: boolean;
  platformEventTranscriptPayload?: Record<string, unknown>;
  slackRoomoteUserId?: string;
  /** The durable row currently running as a fallback whole turn. Excluding it
   * keeps this turn's native steer poller from injecting its own prompt. */
  currentDurableHumanFollowUpEventId?: string;
  /** Trusted setup snapshot injected into setup-session turns. */
  setupSnapshot?: string;
  /** True only for the active conversational setup session; enables
   * setup-only native tools. */
  setupSession?: boolean;
  /**
   * The inline-admitted parent-event row this turn is executing. While the
   * turn stays replay-safe the row remains pending under this owner's claim,
   * so an interruption hands it to the durable queue instead of the user.
   */
  durableAdmission?: {
    eventId: string;
    /** Automatic inference retries earlier executions already consumed. */
    inferenceRetries?: number;
  };
  /** The durable queue is re-running this turn after an interruption. */
  resumedAfterInterruption?: boolean;
  /** The durable queue is re-running this turn at its scheduled retry time
   * after a previous execution parked it on a temporary provider failure. */
  resumedAfterInferenceRetry?: boolean;
}): Promise<string> {
  const turnId = buildFastAgentTurnId({
    currentMessageId,
    conversation,
    question,
  });
  const diagnostics = new FastAgentTurnDiagnostics({
    conversation,
    currentMessageId,
    hasImages: images.length > 0,
    modelRole: FAST_AGENT_MODEL_ROLE,
    turnSource,
    userId,
  });
  const platformEvent = turnSource === 'platform_event';
  const humanInput = input ?? ({ type: 'message' } as const);
  const reactionInput =
    !platformEvent && humanInput.type === FAST_AGENT_REACTION_INPUT_TYPE;
  const substantiveHumanInput = !platformEvent && !reactionInput;
  const currentMessageReactable = substantiveHumanInput;
  const transcriptPayload = reactionInput
    ? { externalInput: humanInput.externalInput }
    : platformEventTranscriptPayload;
  const turnVisibleMessages: ModelMessage[] = [];
  let mirroredMessageCount = 0;
  let canonicalConversationId: string | null = null;
  let durableOpenCodeSessionId: string | null = null;
  let lastVisibleMessage = '';
  let currentInstructionVersion = 0;
  const assistantInstructionVersions = new Map<string, number>();
  const closedInstructionVersions = new Set<number>();
  const getInstructionVersion = (messageId?: string) =>
    (messageId ? assistantInstructionVersions.get(messageId) : undefined) ??
    currentInstructionVersion;
  const isInstructionClosed = (
    instructionVersion = currentInstructionVersion,
  ) => closedInstructionVersions.has(instructionVersion);
  let inferenceRetryReply: FastAgentReplyHandle | undefined;
  let inferenceRetryMessageIndex: number | undefined;
  let inferenceRetryCanonicalEvent:
    | { eventId: string; turnSeq: number }
    | undefined;
  let inferenceRetryAttempted = false;
  // Anchors the silent-recovery window: set on the first retry signal of a
  // continuous no-progress stretch, cleared whenever the provider makes
  // visible progress again (completed message or successful attempt).
  let inferenceRecoveryEpisodeStartedAt: number | undefined;
  // Notice texts already shown during the current recovery episode. Cleared
  // with the episode anchor so a later distinct episode in the same turn can
  // surface an identical notice again.
  const reportedInferenceNotices = new Set<string>();
  const noteInferenceRecoveryProgress = () => {
    inferenceRecoveryEpisodeStartedAt = undefined;
    reportedInferenceNotices.clear();
    // Deliberately leave inferenceRetryReply and inferenceRetryCanonicalEvent
    // alone: the notice slot is owned by the replacement paths (real reply,
    // terminal closeout, abort), and releasing it here would orphan a posted
    // notice and let next-turn reconciliation rewrite it as interrupted.
  };
  // Incremented on every completed OpenCode message and native tool call so
  // the retry loop can distinguish attempts that advanced the turn from
  // attempts that failed without any recoverable progress.
  let turnProgressMarker = 0;
  let consumedProgressMarker = 0;
  let activeOpenCodeSessionId: string | null = null;
  let completedOpenCodeMessage: NonTaskOpenCodeCompletedMessage | null = null;
  let completedOpenCodeInstructionVersion: number | null = null;
  let nextAssistantOrdinal = 0;
  let nextToolOrdinal = 0;
  let nextRetryNoticeOrdinal = 0;
  let nextTurnSeq = 0;
  const degradedContextComponents = new Set<string>();
  let nativeSteer: NonTaskOpenCodeNativeSteer | undefined;
  let activeToolExecutions = 0;
  let respondingLeaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
  // Renewals chain onto this promise so settlement can await the in-flight
  // write before recording the terminal lease state; a fire-and-forget tick
  // could otherwise commit after the settle write and leave an idle Session
  // marked responding for another lease.
  let respondingLeaseRenewal: Promise<void> = Promise.resolve();
  // Durable admission: while true, the persisted turn row is still pending
  // and an interruption hands the turn to the queue instead of the user.
  // Flips off, durably, before the first action a replay could duplicate.
  let durableTurnReplayable = Boolean(durableAdmission);
  /**
   * Withdraw the turn from replay before an action a re-run could duplicate.
   * Resolves true only when this execution's revocation landed on its own
   * still-pending row. A write that did not land, or a row that something
   * else already settled (this execution is then a stale duplicate), both
   * resolve false and the caller must not perform the action.
   */
  const revokeDurableTurnReplay = async (reason: string): Promise<boolean> => {
    if (!durableAdmission || !durableTurnReplayable) return true;
    try {
      const revoked = await revokeFastAgentDurableTurnReplay(
        durableAdmission.eventId,
        reason,
      );
      if (!revoked) {
        console.warn(
          `[Fast Agent] Durable turn row ${durableAdmission.eventId} was no longer pending when replay revocation was attempted; refusing the action.`,
        );
        return false;
      }
      durableTurnReplayable = false;
      return true;
    } catch (error) {
      console.warn(
        `[Fast Agent] Failed to revoke durable turn replay: ${formatErrorForLog(error)}`,
      );
      return false;
    }
  };
  const DURABLE_REVOKE_FAILED_TOOL_ERROR =
    'Roomote could not durably record this action before running it. Try the action again.';
  // Set when a terminal closeout was skipped because its revocation did not
  // land: the user has no answer yet, so settlement must hand the turn to
  // the queue instead of marking it delivered.
  let terminalRevocationFailed = false;
  const settleDurableTurn = async () => {
    if (!durableAdmission) return;
    if (terminalRevocationFailed) {
      durableTurnReplayable = false;
      const released = await releaseFastAgentDurableTurnClaim(
        durableAdmission.eventId,
      ).catch((error) => {
        console.warn(
          `[Fast Agent] Failed to release durable turn claim after a skipped closeout: ${formatErrorForLog(error)}`,
        );
        return false;
      });
      await adapter.requestDurableResume?.().catch((error) => {
        console.warn(
          `[Fast Agent] Failed to wake durable turn resume after a skipped closeout: ${formatErrorForLog(error)}`,
        );
      });
      console.info(
        `[Fast Agent] Durable turn handed to the queue after a skipped closeout (row=${durableAdmission.eventId}, released=${released}).`,
      );
      return;
    }
    durableTurnReplayable = false;
    await markFastAgentDurableTurnDelivered(durableAdmission.eventId).catch(
      (error) => {
        console.warn(
          `[Fast Agent] Failed to settle durable turn: ${formatErrorForLog(error)}`,
        );
      },
    );
  };
  // Set once this execution has parked the turn for a scheduled retry: the
  // row, its retry notice, and the responding lease now belong to the run
  // the queue starts at the scheduled time, so nothing here may settle them.
  let durableTurnDeferred = false;
  // Automatic retries this turn has consumed across all of its executions,
  // whether Roomote's loop or OpenCode's internal backoff scheduled them.
  let durableRetriesConsumed = durableAdmission?.inferenceRetries ?? 0;
  /**
   * Move a pending inference retry out of this process. Only a turn that is
   * still replay-safe can be re-run elsewhere; anything else keeps its
   * backoff in process exactly as before. A schedule that does not land
   * (row superseded or withdrawn, write failed) also falls back to the
   * in-process wait, so durability here is best effort like admission.
   */
  const deferInferenceRetry = async (
    notice: FastAgentInferenceRetryNotice & { inProcessAttempt: number },
  ): Promise<Date | null> => {
    if (
      !durableAdmission ||
      !durableTurnReplayable ||
      !adapter.requestDurableRetry ||
      Env.R_FAST_DURABLE_RETRY_DISABLED ||
      notice.delayMs === undefined ||
      signal?.aborted ||
      isInstructionClosed()
    ) {
      return null;
    }
    // A one-off blip is cheapest to ride out where it happened: the first
    // in-process retry stays in place unless its wait is already long.
    // From the second attempt on, the wait leaves the process.
    if (
      notice.inProcessAttempt < 2 &&
      notice.delayMs < FAST_AGENT_DURABLE_RETRY_IMMEDIATE_PARK_WAIT_MS
    ) {
      return null;
    }
    // Parks back off across handoffs (each one re-prompts from scratch) and
    // never shorten a provider-issued wait. The episode as a whole is bounded
    // by the horizon from its first failure plus the handoff cap; past that,
    // the in-process retries and their honest terminal failure take over.
    const now = Date.now();
    const episodeStartedAt = inferenceRecoveryEpisodeStartedAt ?? now;
    const parkDelayMs = Math.max(
      notice.delayMs,
      Math.min(
        FAST_AGENT_DURABLE_RETRY_PARK_MAX_DELAY_MS,
        FAST_AGENT_DURABLE_RETRY_PARK_BASE_DELAY_MS *
          2 ** durableRetriesConsumed,
      ),
    );
    if (
      durableRetriesConsumed >= FAST_AGENT_DURABLE_RETRY_MAX_PARKS ||
      now + parkDelayMs - episodeStartedAt > FAST_AGENT_DURABLE_RETRY_HORIZON_MS
    ) {
      return null;
    }
    const retryAt = new Date(now + parkDelayMs);
    const inferenceRetries = durableRetriesConsumed + 1;
    const scheduled = await scheduleFastAgentDurableTurnRetry(
      durableAdmission.eventId,
      {
        retryAt,
        inferenceRetries,
        reason: `Inference retry ${inferenceRetries} scheduled (${notice.failure.reason}).`,
      },
    ).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to schedule a durable inference retry: ${formatErrorForLog(error)}`,
      );
      return false;
    });
    if (!scheduled) return null;
    durableTurnReplayable = false;
    durableTurnDeferred = true;
    durableRetriesConsumed = inferenceRetries;
    await adapter.requestDurableRetry(retryAt).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to queue the durable inference retry wakeup: ${formatErrorForLog(error)}`,
      );
    });
    console.info(
      `[Fast Agent] Parked the turn for a durable inference retry (row=${durableAdmission.eventId}, retryAt=${retryAt.toISOString()}, retries=${inferenceRetries}, reason=${notice.failure.reason}).`,
    );
    return retryAt;
  };
  let activeHumanSteerPoll = Promise.resolve();
  const injectedHumanFollowUpIds = new Set<string>();
  const deferredOversizedHumanFollowUpIds = new Set<string>();
  const humanFollowUpTurnSeqs = new Map<string, number>();
  const injectedHumanFollowUpMessages: ModelMessage[] = [];
  const injectedHumanFollowUpFiles: NonTaskPromptFile[] = [];
  const integrationCallSignatures = new Set<string>();
  const completedChatReactionSignatures = new Set<string>();
  const completedChatReplySignatures = new Set<string>();
  const completedTaskActions = new Set<string>();
  const stopHumanSteerPolling = () => {
    nativeSteer = undefined;
  };
  signal?.addEventListener('abort', stopHumanSteerPolling, { once: true });

  const allocateCanonicalEvent = (slot: string) => ({
    eventId: `${turnId}:${slot}`,
    turnSeq: nextTurnSeq++,
  });
  // The model's assistant text is the reply. Its not-yet-delivered text
  // streams to the web transcript as assistant message chunks under a
  // reserved event; the reply that delivers it (a reply tool call or the
  // terminal closeout) persists under that same event, so the live text is
  // replaced in place.
  const replyTextTracker = createFastAgentReplyTextTracker();
  const replyStream = createFastAgentReplyStreamPublisher({
    getConversationId: () => canonicalConversationId,
  });
  let streamedReply:
    | { eventId: string; turnSeq: number; sentText: string }
    | undefined;
  // A chat surface with a streaming API renders the same undelivered text
  // as it is written; the reply that delivers it takes over that message.
  // Platform events (automation reports, task settlements) post whole.
  const surfaceReplyStream = createFastAgentSurfaceReplyStreamer({
    ...(adapter.createReplyStream && !platformEvent
      ? { createStream: adapter.createReplyStream }
      : {}),
  });
  const onAssistantTextUpdated = (update: NonTaskOpenCodeAssistantText) => {
    replyTextTracker.apply(update);
    // Text after a closeout belongs to the trailing model request that the
    // turn is already cutting off; never show it.
    if (isInstructionClosed(getInstructionVersion(update.messageId))) return;
    const text = replyTextTracker.unconsumedText();
    if (!text.trim()) return;
    surfaceReplyStream.update(text, replyTextTracker.hasIncompleteUnconsumed());
    streamedReply ??= {
      ...allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
      sentText: '',
    };
    // Only appends stream. A rewrite of earlier text (rare: a completing
    // part correcting drift) is left to the persisted row.
    if (!text.startsWith(streamedReply.sentText)) return;
    const delta = text.slice(streamedReply.sentText.length);
    if (!delta) return;
    streamedReply.sentText = text;
    replyStream.publishChunk({
      eventId: streamedReply.eventId,
      sessionId: activeOpenCodeSessionId,
      turnId: update.messageId,
      ts: Date.now(),
      text: delta,
    });
  };
  /** Hands the streamed text's event to the reply that finalizes it. */
  const takeStreamedReplyEvent = async () => {
    const streamed = streamedReply;
    streamedReply = undefined;
    if (!streamed) return undefined;
    await replyStream.flush();
    return { eventId: streamed.eventId, turnSeq: streamed.turnSeq };
  };
  /** Forgets streamed text no reply will deliver; the transcript drops it
   * when the turn settles. */
  const dropStreamedReply = () => {
    streamedReply = undefined;
  };
  const waitForSettledReplyText = async () => {
    const deadline = Date.now() + FAST_AGENT_REPLY_TEXT_SETTLE_TIMEOUT_MS;
    while (
      !signal?.aborted &&
      (!replyTextTracker.unconsumedText().trim() ||
        replyTextTracker.hasIncompleteUnconsumed()) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, FAST_AGENT_REPLY_TEXT_SETTLE_POLL_MS),
      );
    }
  };
  /**
   * The closeout owed when the model ends its turn with undelivered text.
   * The prompt result is the final assistant message's full text; strip
   * what an earlier reply already delivered from that same message.
   */
  const resolveTerminalReplyText = (promptText: string) => {
    if (!replyTextTracker.sawText()) return promptText;
    const delivered = completedOpenCodeMessage?.id
      ? replyTextTracker.consumedText(completedOpenCodeMessage.id)
      : '';
    const remainder = !delivered
      ? promptText
      : promptText.startsWith(delivered)
        ? promptText.slice(delivered.length)
        : replyTextTracker.unconsumedText();
    replyTextTracker.consumeUnconsumed();
    return remainder;
  };
  const persistCanonicalMessage = async (
    message: Parameters<typeof upsertFastAgentMessage>[0]['message'],
    bestEffort = false,
  ): Promise<
    Awaited<ReturnType<typeof upsertFastAgentMessage>> | undefined
  > => {
    if (!canonicalConversationId) {
      if (bestEffort) return;
      throw new Error(
        'Fast conversation is not ready for message persistence.',
      );
    }

    try {
      return await upsertFastAgentMessage({
        sessionId: canonicalConversationId,
        message,
      });
    } catch (error) {
      if (!bestEffort) throw error;
      console.error(
        `[Fast Agent] Failed to persist canonical message conversation=${canonicalConversationId} event=${message.eventId}: ${formatErrorForLog(error)}`,
      );
    }
  };
  const drainPendingHumanSteers = async () => {
    if (
      signal?.aborted ||
      !canonicalConversationId ||
      !nativeSteer ||
      activeToolExecutions > 0
    ) {
      return;
    }

    for (;;) {
      const rows = await getPendingFastAgentHumanFollowUps(
        canonicalConversationId,
        currentDurableHumanFollowUpEventId,
      );
      if (
        signal?.aborted ||
        rows.length === 0 ||
        !nativeSteer ||
        activeToolExecutions > 0
      ) {
        return;
      }
      if (deferredOversizedHumanFollowUpIds.has(rows[0]!.id)) return;

      const alreadyInjectedIds: string[] = [];
      const batch: Array<{
        row: (typeof rows)[number];
        followUp: z.infer<typeof fastAgentHumanFollowUpEventSchema>;
        followUpTurnId: string;
        turnMessages: ModelMessage[];
        serializedPrompt: string;
        files: NonTaskPromptFile[];
      }> = [];
      let batchTextBytes = 0;
      let batchFileCount = 0;
      let batchFileBytes = 0;
      let blockedByDifferentUser = false;

      for (const row of rows) {
        const parsed = fastAgentHumanFollowUpEventSchema.safeParse(row.event);
        if (
          !parsed.success ||
          row.parent.sessionId !== canonicalConversationId
        ) {
          await db
            .update(fastAgentParentEvents)
            .set({
              discardedAt: new Date(),
              lastError: 'Queued Fast human follow-up was invalid.',
              updatedAt: new Date(),
            })
            .where(eq(fastAgentParentEvents.id, row.id));
          continue;
        }

        if (injectedHumanFollowUpIds.has(row.id)) {
          alreadyInjectedIds.push(row.id);
          continue;
        }

        const followUp = parsed.data;
        if (followUp.userId !== userId) {
          // The active turn's tools and integration clients are scoped to its
          // initiating user. Preserve global queue order: deliver the current
          // actor's contiguous prefix, then leave this participant and every
          // later message durable for separately authorized turns.
          blockedByDifferentUser = true;
          break;
        }

        const followUpTurnId = buildFastAgentTurnId({
          currentMessageId: followUp.currentMessageId,
          conversation,
          question: followUp.question,
        });
        const { turnMessages } = buildFastAgentMessages({
          question: followUp.question,
          threadContext: [],
          compatibilityMessages: [],
          currentMessageTs: followUp.currentMessageId,
          currentMessageSender: {
            slackUserId: followUp.senderExternalId,
            displayName: followUp.senderDisplayName,
          },
          surface: conversation.surface,
          reactionInput: false,
          turnSource: 'human',
          slackRoomoteUserId,
        });
        const serializedPrompt = serializeFastAgentMessages(turnMessages);
        const files = getFastAgentImageFiles(followUp.images ?? []);
        const serializedPromptBytes = Buffer.byteLength(
          serializedPrompt,
          'utf8',
        );
        const filesBytes = files.reduce(
          (total, file) =>
            total +
            Buffer.byteLength(file.url, 'utf8') +
            Buffer.byteLength(file.mime, 'utf8') +
            Buffer.byteLength(file.filename ?? '', 'utf8'),
          0,
        );
        const separatorBytes = batch.length > 0 ? 2 : 0;
        const exceedsBatchLimit =
          batch.length >= FAST_AGENT_HUMAN_STEER_MAX_MESSAGES ||
          batchTextBytes + separatorBytes + serializedPromptBytes >
            FAST_AGENT_HUMAN_STEER_MAX_TEXT_BYTES ||
          batchFileCount + files.length > FAST_AGENT_HUMAN_STEER_MAX_FILES ||
          batchFileBytes + filesBytes > FAST_AGENT_HUMAN_STEER_MAX_FILE_BYTES;
        if (exceedsBatchLimit) {
          if (batch.length > 0) break;
          // A single oversized follow-up cannot be split without changing its
          // meaning or attachments. Leave it durable for the normal queued
          // whole-turn fallback instead of hot-retrying promptAsync forever.
          deferredOversizedHumanFollowUpIds.add(row.id);
          console.info(
            `[Fast Agent] Native steer deferred. conversationId="${canonicalConversationId}" reason="oversized_singleton"`,
          );
          return;
        }

        batchTextBytes += separatorBytes + serializedPromptBytes;
        batchFileCount += files.length;
        batchFileBytes += filesBytes;
        batch.push({
          row,
          followUp,
          followUpTurnId,
          turnMessages,
          serializedPrompt,
          files,
        });
      }

      await markFastAgentHumanFollowUpsDelivered(alreadyInjectedIds);
      if (batch.length === 0) {
        if (blockedByDifferentUser) return;
        continue;
      }

      if (signal?.aborted) return;
      for (const { row, followUp, followUpTurnId } of batch) {
        await persistCanonicalMessage({
          eventId: `${followUpTurnId}:user`,
          turnId: followUpTurnId,
          turnSeq:
            humanFollowUpTurnSeqs.get(row.id) ??
            (() => {
              const turnSeq = nextTurnSeq++;
              humanFollowUpTurnSeqs.set(row.id, turnSeq);
              return turnSeq;
            })(),
          ts: row.createdAt.getTime(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          contentBlocks: buildFastAgentUserContentBlocks(
            normalizeThreadText(followUp.question),
            followUp.images ?? [],
          ),
          metadata: {
            visibleInTranscript: true,
            turnSource: 'human',
            userId: followUp.userId,
            ...(followUp.senderDisplayName
              ? {
                  userName: followUp.senderDisplayName,
                  senderDisplayName: followUp.senderDisplayName,
                }
              : {}),
            ...(followUp.senderExternalId
              ? { senderExternalId: followUp.senderExternalId }
              : {}),
          },
          payload: {},
          source: conversation.surface,
          nativeSessionId: activeOpenCodeSessionId,
        });
      }
      if (signal?.aborted || !nativeSteer || activeToolExecutions > 0) return;
      const batchMessages = batch.flatMap(({ turnMessages }) => turnMessages);
      const batchFiles = batch.flatMap(({ files }) => files);
      const batchPrompt = batch
        .map(({ serializedPrompt }) => serializedPrompt)
        .join('\n\n');
      const firstRow = batch[0]!.row;
      const previousInstructionVersion = currentInstructionVersion;
      const steerInstructionVersion = previousInstructionVersion + 1;
      currentInstructionVersion = steerInstructionVersion;
      try {
        await nativeSteer({
          messageId: buildFastAgentNativeSteerMessageId(
            firstRow.id,
            firstRow.createdAt,
          ),
          text: batchPrompt,
          files: batchFiles,
        });
      } catch (error) {
        if (currentInstructionVersion === steerInstructionVersion) {
          currentInstructionVersion = previousInstructionVersion;
        }
        throw error;
      }
      if (signal?.aborted) return;
      console.info(
        `[Fast Agent] Native steer accepted. conversationId="${canonicalConversationId}" followUpCount=${batch.length}`,
      );
      for (const { row } of batch) injectedHumanFollowUpIds.add(row.id);
      injectedHumanFollowUpMessages.push(...batchMessages);
      injectedHumanFollowUpFiles.push(...batchFiles);
      // Native steering starts a new human instruction boundary inside the
      // same OpenCode run. Prior tool results remain in-session, while local
      // duplicate guards reset so the user may intentionally repeat an action.
      integrationCallSignatures.clear();
      completedChatReactionSignatures.clear();
      completedChatReplySignatures.clear();
      completedTaskActions.clear();
      turnVisibleMessages.push(...batchMessages);
      await markFastAgentHumanFollowUpsDelivered(
        batch.map(({ row }) => row.id),
      );
    }
  };
  const schedulePendingHumanSteerDrain = () => {
    activeHumanSteerPoll = activeHumanSteerPoll
      .then(drainPendingHumanSteers)
      .catch((error) => {
        console.error(
          `[Fast Agent] Failed to inject a native human steer: ${formatErrorForLog(error)}`,
        );
      });
    return activeHumanSteerPoll;
  };
  const persistAssistantReply = async ({
    reply,
    event,
    platformMessageId,
    nativeMessage,
    inferenceRetryNotice = false,
    visibleInTranscript = true,
    interruptionReason,
    ts,
  }: {
    reply: FastAgentReply;
    event: { eventId: string; turnSeq: number };
    platformMessageId?: string;
    nativeMessage?: NonTaskOpenCodeCompletedMessage | null;
    inferenceRetryNotice?: boolean;
    visibleInTranscript?: boolean;
    interruptionReason?: FastAgentInterruptionReason;
    /** Explicit event time; retry notices pin it to the episode start. */
    ts?: number;
  }) =>
    persistCanonicalMessage(
      {
        ...event,
        turnId,
        // createdAtMs predates the turn's tool events and would sort the
        // reply above the tool activity that produced it, so fall straight
        // through to the persist-time clock when completion time is missing.
        ts: ts ?? nativeMessage?.completedAtMs ?? Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: reply.message }],
        metadata: {
          visibleInTranscript,
          purpose: reply.purpose,
          ...(inferenceRetryNotice
            ? {
                inferenceRetryNotice: true,
                inferenceRetryActive: reply.purpose === 'progress',
              }
            : {}),
          ...(interruptionReason ? { interruptionReason } : {}),
          ...(platformMessageId ? { platformMessageId } : {}),
        },
        payload: {
          purpose: reply.purpose,
          ...(transcriptPayload ?? {}),
          ...(reply.imageArtifactIds?.length
            ? { imageArtifactIds: reply.imageArtifactIds }
            : {}),
          ...(reply.kickoff ? { kickoff: true } : {}),
        },
        source: conversation.surface,
        nativeSessionId: nativeMessage?.sessionId ?? activeOpenCodeSessionId,
        nativeMessageId: nativeMessage?.id ?? null,
      },
      true,
    );
  const beginCanonicalToolEvent = async ({
    title,
    args,
    nativeSessionId,
    mcpServerName = null,
    mcpToolName = null,
    kind = mcpServerName && mcpToolName ? 'mcp' : 'tool',
  }: {
    title: string;
    args: Record<string, unknown>;
    nativeSessionId?: string | null;
    mcpServerName?: string | null;
    mcpToolName?: string | null;
    kind?: string;
  }) => {
    const ordinal = nextToolOrdinal++;
    const toolCallId = `${turnId}:tool:${ordinal}`;
    const isMcp = Boolean(mcpServerName && mcpToolName);
    const visibleInTranscript =
      title !== FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply &&
      title !== FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction;
    const canonicalEvent = allocateCanonicalEvent(`tool:${ordinal}`);
    await persistCanonicalMessage(
      {
        ...canonicalEvent,
        turnId,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        role: 'tool',
        contentBlocks: [],
        metadata: { visibleInTranscript },
        payload: {
          toolCallId,
          title,
          kind,
          status: 'in_progress',
          isExecute: false,
          isRead: kind === 'read',
          isMcp,
          isRoomoteNativeTool: !isMcp,
          mcpServerName,
          mcpToolName,
          serverName: mcpServerName,
          toolName: mcpToolName ?? title,
          command: null,
          rawInput: { arguments: args },
        },
        source: conversation.surface,
        nativeSessionId: nativeSessionId ?? activeOpenCodeSessionId,
      },
      true,
    );
    return {
      ordinal,
      toolCallId,
      title,
      args,
      isMcp,
      mcpServerName,
      mcpToolName,
      kind,
      visibleInTranscript,
      canonicalEvent,
    };
  };
  const finishCanonicalToolEvent = async (
    event: Awaited<ReturnType<typeof beginCanonicalToolEvent>>,
    result: unknown,
    nativeSessionId?: string | null,
  ) => {
    const { output, truncated } = serializeFastAgentToolOutput(result);
    const failed =
      result !== null &&
      typeof result === 'object' &&
      'success' in result &&
      result.success === false;
    await persistCanonicalMessage(
      {
        ...event.canonicalEvent,
        turnId,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        role: 'tool',
        contentBlocks: output ? [{ type: 'text', text: output }] : [],
        metadata: { visibleInTranscript: event.visibleInTranscript, truncated },
        payload: {
          toolCallId: event.toolCallId,
          title: event.title,
          kind: event.kind,
          status: failed ? 'failed' : 'completed',
          isExecute: false,
          isRead: event.kind === 'read',
          isMcp: event.isMcp,
          isRoomoteNativeTool: !event.isMcp,
          mcpServerName: event.mcpServerName,
          mcpToolName: event.mcpToolName,
          serverName: event.mcpServerName,
          toolName: event.mcpToolName ?? event.title,
          command: null,
          exitCode: null,
          output,
          rawInput: { arguments: event.args },
        },
        source: conversation.surface,
        nativeSessionId: nativeSessionId ?? activeOpenCodeSessionId,
      },
      true,
    );
  };
  const canonicalSubagentEvents = new Map<
    string,
    { eventId: string; turnSeq: number }
  >();
  const persistOpenCodeTaskPart = async (part: NonTaskOpenCodeTaskPart) => {
    const eventKey = `${part.sessionId}:${part.messageId}:${part.toolCallId}`;
    let canonicalEvent = canonicalSubagentEvents.get(eventKey);
    if (!canonicalEvent) {
      canonicalEvent = allocateCanonicalEvent(
        `subagent:${part.messageId}:${part.partId}`,
      );
      canonicalSubagentEvents.set(eventKey, canonicalEvent);
    }

    const terminal = part.status !== 'in_progress';
    const rawOutput = part.output ?? part.error ?? '';
    const { text: output, truncation } = truncateAcpOutputText(
      typeof rawOutput === 'string'
        ? rawOutput
        : stringifyFastAgentToolOutput(rawOutput),
      FAST_AGENT_CANONICAL_TOOL_OUTPUT_MAX_CHARS,
    );
    const truncated = truncation !== null;
    const payload = {
      sessionId: part.sessionId,
      turnId: part.messageId,
      toolCallId: part.toolCallId,
      kind: 'subagent',
      title: part.title,
      status: part.status,
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      isSubagentSpawn: true,
      senderThreadId: part.sessionId,
      receiverThreadIds: [],
      agentType: part.agentType ?? null,
      rawInput: part.input,
      ...(terminal ? { exitCode: null, output } : {}),
    };

    await persistCanonicalMessage({
      ...canonicalEvent,
      turnId,
      ts: Date.now(),
      eventType: terminal
        ? ACP_ENVELOPE_EVENT_TYPES.ToolResult
        : ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      role: 'tool',
      contentBlocks: terminal && output ? [{ type: 'text', text: output }] : [],
      metadata: {
        visibleInTranscript: true,
        ...(terminal ? { truncated } : {}),
      },
      payload,
      source: conversation.surface,
      nativeSessionId: part.sessionId,
      nativeMessageId: part.messageId,
    });
  };

  const replaceInferenceRetryReply = async (
    reply: FastAgentReply,
    bestEffort = false,
    onDelivered?: () => void,
    interruptionReason?: FastAgentInterruptionReason,
  ): Promise<boolean> => {
    if (!inferenceRetryCanonicalEvent) {
      return false;
    }

    const retryEvent = inferenceRetryCanonicalEvent;
    const retryMessageIndex = inferenceRetryMessageIndex;
    // A progress notice keeps the episode's start time; a terminal
    // replacement takes the clock like any other reply.
    const noticeTs =
      reply.purpose === 'progress'
        ? inferenceRecoveryEpisodeStartedAt
        : undefined;
    if (!inferenceRetryReply || !adapter.replaceReply) {
      if (
        retryMessageIndex !== undefined &&
        retryMessageIndex >= mirroredMessageCount
      ) {
        turnVisibleMessages.splice(retryMessageIndex, 1);
      }
      await persistAssistantReply({
        reply,
        event: retryEvent,
        inferenceRetryNotice: true,
        visibleInTranscript: false,
        interruptionReason,
        ts: noticeTs,
      });
      return false;
    }

    let replacement: FastAgentReplyHandle | void;
    try {
      replacement = await adapter.replaceReply(inferenceRetryReply, reply);
      onDelivered?.();
    } catch (error) {
      if (!bestEffort) {
        await persistAssistantReply({
          reply,
          event: retryEvent,
          inferenceRetryNotice: true,
          interruptionReason,
          ts: noticeTs,
        });
        throw error;
      }
      console.warn(
        `[Fast Agent] Failed to replace inference retry notice: ${formatErrorForLog(error)}`,
      );
      if (
        retryMessageIndex !== undefined &&
        retryMessageIndex >= mirroredMessageCount
      ) {
        turnVisibleMessages.splice(retryMessageIndex, 1);
      }
      await persistAssistantReply({
        reply,
        event: retryEvent,
        inferenceRetryNotice: true,
        visibleInTranscript: false,
        interruptionReason,
        ts: noticeTs,
      });
      return false;
    }
    inferenceRetryReply = replacement || inferenceRetryReply;
    if (inferenceRetryMessageIndex !== undefined) {
      turnVisibleMessages[inferenceRetryMessageIndex] =
        buildAssistantTextMessage(reply.message);
    }
    if (inferenceRetryCanonicalEvent) {
      await persistAssistantReply({
        reply,
        event: retryEvent,
        platformMessageId: inferenceRetryReply.messageId,
        inferenceRetryNotice: true,
        interruptionReason,
        ts: noticeTs,
      });
    }
    return true;
  };

  try {
    adapter.activity?.start();
  } catch (error) {
    console.warn(
      `[Fast Agent] Failed to start surface activity: ${formatErrorForLog(error)}`,
    );
  }

  try {
    if (substantiveHumanInput) {
      turnVisibleMessages.push(
        buildUserTextMessage(normalizeThreadText(question)),
      );
    }
    const [
      availableEnvironments,
      taskModelOptions,
      session,
      discoveredIntegrations,
      currentUser,
    ] = await Promise.all([
      getAvailableEnvironments(),
      getDeploymentTaskModelOptions().catch((error) => {
        degradedContextComponents.add('task_model_catalog');
        console.warn(
          `[Fast Agent] Task model options unavailable: ${formatErrorForLog(error)}`,
        );
        return { models: [], defaultModelId: undefined };
      }),
      getOrCreateFastAgentSession({ userId, conversation }),
      listFastAgentIntegrations(
        { userId, apiBaseUrl },
        adapter.resolveMcpServerConfigs,
      ).catch((error) => {
        degradedContextComponents.add('integration_catalog');
        console.warn(
          `[Fast Agent] Deployment MCP servers unavailable: ${formatErrorForLog(error)}`,
        );
        return [];
      }),
      platformEvent
        ? Promise.resolve({
            displayName: null,
            githubLogin: null,
            isAdmin: false,
          })
        : getFastAgentUserIdentity(userId).catch((error) => {
            degradedContextComponents.add('user_identity');
            console.warn(
              `[Fast Agent] User identity unavailable: ${formatErrorForLog(error)}`,
            );
            return { displayName: null, githubLogin: null, isAdmin: false };
          }),
    ]);
    const availableIntegrations = selectFastRoomoteChannelTools({
      integrations: discoveredIntegrations,
      conversation,
      currentMessageReactable,
    });
    canonicalConversationId = session.id;
    // A resumed execution of this same turn inherits the retry notice its
    // predecessor left active, so the eventual answer edits that notice in
    // place; only when no such notice exists (or this is a new turn) does a
    // still-active notice mean an interrupted turn to reconcile.
    const inheritedRetryNotice =
      durableAdmission &&
      (resumedAfterInterruption || resumedAfterInferenceRetry)
        ? await findFastAgentActiveInferenceRetryNotice(
            session.id,
            turnId,
          ).catch((error) => {
            console.warn(
              `[Fast Agent] Failed to look up the inherited inference retry notice: ${formatErrorForLog(error)}`,
            );
            return null;
          })
        : null;
    if (inheritedRetryNotice) {
      inferenceRetryAttempted = true;
      inferenceRetryCanonicalEvent = {
        eventId: inheritedRetryNotice.eventId,
        turnSeq: nextTurnSeq++,
      };
      nextRetryNoticeOrdinal += 1;
      inferenceRetryReply = inheritedRetryNotice.platformMessageId
        ? { messageId: inheritedRetryNotice.platformMessageId }
        : undefined;
      inferenceRecoveryEpisodeStartedAt = inheritedRetryNotice.ts;
      if (inheritedRetryNotice.platformMessageId) {
        reportedInferenceNotices.add(inheritedRetryNotice.text);
      }
    } else {
      await reconcileFastAgentInferenceRetryNotices(
        session.id,
        'next_turn_reconcile',
      ).catch((error) => {
        console.warn(
          `[Fast Agent] Failed to reconcile interrupted inference retry notices: ${formatErrorForLog(error)}`,
        );
      });
    }
    await setFastSessionResponding(
      session.id,
      true,
      () => !signal?.aborted,
    ).catch((error) => {
      console.warn(
        `[sessions] Failed to mark Fast Session active: ${formatErrorForLog(error)}`,
      );
    });
    // Assistant-message persists extend the lease as a side effect, but a
    // turn can spend longer than the lease inside tool calls or a streaming
    // stretch without persisting one, and the expired-lease reconciler would
    // then stamp its live retry notice as interrupted. Renew on wall clock
    // for as long as this owner is executing; the tick stops renewing the
    // moment ownership is aborted so a fenced-off owner cannot extend a
    // successor's lease.
    respondingLeaseRenewalTimer = setInterval(() => {
      if (signal?.aborted) return;
      respondingLeaseRenewal = respondingLeaseRenewal.then(async () => {
        // The abort check is only a cheap short-circuit; correctness comes
        // from the renewal statement itself, which extends the lease only
        // where it is still live, so a stale write cannot resurrect a lease
        // a settlement or successor already cleared.
        if (signal?.aborted) return;
        await renewFastSessionRespondingLease(session.id).catch((error) => {
          console.warn(
            `[sessions] Failed to renew Fast Session responding lease: ${formatErrorForLog(error)}`,
          );
        });
        if (durableAdmission && durableTurnReplayable) {
          await renewFastAgentDurableTurnClaim(durableAdmission.eventId).catch(
            (error) => {
              console.warn(
                `[Fast Agent] Failed to renew durable turn claim: ${formatErrorForLog(error)}`,
              );
            },
          );
        }
      });
    }, FAST_RESPONDING_LEASE_RENEW_MS);
    respondingLeaseRenewalTimer.unref();
    durableOpenCodeSessionId = session.openCodeSessionId;
    activeOpenCodeSessionId = session.openCodeSessionId;
    diagnostics.setCanonicalConversationId(session.id);
    // Look up before this turn's own prompt is persisted, so "the latest
    // turn" is the previous one. Only a substantive human turn can resume an
    // owed request; platform events and reactions leave it for the next one.
    const unresolvedRequest = substantiveHumanInput
      ? await findFastAgentUnresolvedRequest(session.id).catch((error) => {
          console.warn(
            `[Fast Agent] Failed to look up an unresolved request: ${formatErrorForLog(error)}`,
          );
          return null;
        })
      : null;
    const userEvent = allocateCanonicalEvent('user');
    const userMessageResult = await persistCanonicalMessage(
      {
        ...userEvent,
        turnId,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: buildFastAgentUserContentBlocks(
          normalizeThreadText(question),
          images,
        ),
        metadata: {
          // Synthetic envelopes are useful model input but not readable
          // transcript or title seeds.
          visibleInTranscript: substantiveHumanInput,
          turnSource,
          ...(reactionInput
            ? { inputKind: FAST_AGENT_REACTION_INPUT_TYPE }
            : {}),
          ...(platformEvent ? { platformEventKind } : {}),
          // Lineage back to the interrupted request this turn is resuming,
          // so the original still surfaces if this turn is interrupted too.
          ...(unresolvedRequest
            ? { resumesTurnId: unresolvedRequest.turnId }
            : {}),
          userId,
          ...(senderDisplayName ? { userName: senderDisplayName } : {}),
          ...(senderDisplayName ? { senderDisplayName } : {}),
          ...(senderExternalId ? { senderExternalId } : {}),
        },
        payload: {},
        source: conversation.surface,
      },
      true,
    );
    diagnostics.recordInitialHumanTurn(
      substantiveHumanInput ? userMessageResult?.initialHumanTurn : false,
    );
    if (
      substantiveHumanInput ||
      (platformEvent && platformEventKind === 'automation')
    ) {
      void refreshFastAgentSessionTitle({ sessionId: session.id, userId }).then(
        (title) => adapter.activity?.updateTitle?.(title),
      );
    }
    const sessionActiveTasks = await getActiveFastAgentTasks(session.id);
    const resolvedActiveTasks = [
      ...new Map(
        [...activeTasks, ...sessionActiveTasks].map((task) => [
          task.taskId,
          task,
        ]),
      ).values(),
    ];
    const currentTasks = new Map(
      resolvedActiveTasks.map((task) => [task.taskId, task]),
    );
    const currentMessageSender = platformEvent
      ? undefined
      : {
          slackUserId: senderExternalId,
          displayName:
            senderDisplayName?.trim() || currentUser.displayName || undefined,
          githubLogin: currentUser.githubLogin || undefined,
        };
    const {
      bootstrapMessages,
      turnMessages,
      bootstrapThreadContextPresent,
      turnThreadContextPresent,
    } = buildFastAgentMessages({
      question,
      currentMessageAgentContext,
      threadContext,
      compatibilityMessages: session.compatibilityMessages,
      currentMessageTs: currentMessageId,
      currentMessageSender,
      surface: conversation.surface,
      reactionInput,
      turnSource,
      slackRoomoteUserId,
      unresolvedRequest,
      resumedAfterInterruption,
      resumedAfterInferenceRetry,
    });
    const releaseVersion = resolveRoomoteReleaseVersion(
      Env.RELEASE_PRODUCT_VERSION,
      Env.RELEASE_VERSION,
      packageJson.version,
    );
    const system = buildFastAgentSystemPrompt({
      availableEnvironments,
      availableTaskModels: taskModelOptions.models,
      defaultTaskModelId: taskModelOptions.defaultModelId,
      availableIntegrations,
      activeTasks: resolvedActiveTasks,
      surface: conversation.surface,
      turnSource,
      input: humanInput,
      platformEventHandling,
      platformEventVisibility,
      platformEventKind,
      retryTaskStartAvailable: Boolean(adapter.retryTaskStart),
      allowSilentAmbientReply,
      isCurrentUserAdmin: currentUser.isAdmin,
      implicitAutomationOffersEnabled: !Env.R_FAST_AUTOMATION_OFFERS_DISABLED,
      releaseVersion,
      ...(setupSnapshot ? { setupSnapshot } : {}),
      setupSession,
    });
    diagnostics.recordPromptContext({
      systemPromptChars: system.length,
      environmentCount: availableEnvironments.length,
      integrationCount: availableIntegrations.length,
      integrationToolCount: availableIntegrations.reduce(
        (count, integration) => count + integration.tools.length,
        0,
      ),
      activeTaskCount: resolvedActiveTasks.length,
    });
    let visibleUpdatePosted = false;
    let substantiveWorkAcknowledged = false;
    let nativeToolInvoked = false;
    let retriedTaskStart = false;

    const mirrorPendingMessages = async (strict = false) => {
      const pending = turnVisibleMessages.slice(mirroredMessageCount);
      if (pending.length === 0) return;
      try {
        await appendFastAgentVisibleMessages({
          sessionId: session.id,
          messages: pending,
        });
        mirroredMessageCount = turnVisibleMessages.length;
      } catch (error) {
        if (strict) throw error;
        console.error(
          `[Fast Agent] Failed to mirror visible messages for N-1 rollback: ${formatErrorForLog(error)}`,
        );
      }
    };

    const postReply = async (
      reply: FastAgentReply,
      mirrorImmediately = false,
      nativeMessage?: NonTaskOpenCodeCompletedMessage | null,
      instructionVersion = currentInstructionVersion,
      /** The streamed partial this reply finalizes, if one was shown. */
      streamedEvent?: { eventId: string; turnSeq: number },
    ) => {
      const replacedRetry = await replaceInferenceRetryReply(reply, true, () =>
        diagnostics.recordVisibleReply(),
      );
      if (!replacedRetry) {
        const posted =
          (await surfaceReplyStream.deliver(reply)) ??
          (await adapter.postReply(reply));
        diagnostics.recordVisibleReply();
        turnVisibleMessages.push(buildAssistantTextMessage(reply.message));
        await persistAssistantReply({
          reply,
          event:
            streamedEvent ??
            allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
          platformMessageId: posted?.messageId,
          nativeMessage,
        });
      }
      inferenceRetryReply = undefined;
      inferenceRetryMessageIndex = undefined;
      inferenceRetryCanonicalEvent = undefined;
      lastVisibleMessage = reply.message;
      visibleUpdatePosted = true;
      // Any text reply posted by the model (acknowledgement, first progress
      // update, or task kickoff) is the textual communication the work-start
      // gate requires. Reactions deliberately do not set this flag.
      substantiveWorkAcknowledged = true;
      if (reply.purpose === 'closeout' || reply.purpose === 'clarification') {
        closedInstructionVersions.add(instructionVersion);
      }
      if (mirrorImmediately) {
        await mirrorPendingMessages(true);
      }
    };
    const recordChatReaction = async (
      name: string,
      purpose: 'ack' | 'closeout',
      messageId: string,
      instructionVersion = currentInstructionVersion,
    ) => {
      const signature = JSON.stringify([name, purpose, messageId]);
      if (completedChatReactionSignatures.has(signature)) {
        return {
          success: true as const,
          delivered: true,
          duplicate: true,
          closed: isInstructionClosed(instructionVersion),
        };
      }
      completedChatReactionSignatures.add(signature);
      const reactionText = `:${name}:`;
      turnVisibleMessages.push(buildAssistantTextMessage(reactionText));
      await persistCanonicalMessage(
        {
          ...allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
          turnId,
          ts: Date.now(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: reactionText }],
          metadata: { visibleInTranscript: true },
          payload: { reaction: name, purpose },
          source: conversation.surface,
          nativeSessionId: activeOpenCodeSessionId,
        },
        true,
      );
      visibleUpdatePosted = true;
      if (purpose === 'closeout') {
        closedInstructionVersions.add(instructionVersion);
      }
      return {
        success: true as const,
        delivered: true,
        closed: isInstructionClosed(instructionVersion),
      };
    };
    const postChatReaction = async (
      rawName: string,
      purpose: 'ack' | 'closeout',
      instructionVersion = currentInstructionVersion,
    ) => {
      if (!currentMessageReactable) {
        return {
          success: false as const,
          error:
            'Emoji reactions are unavailable for this input. Use send_chat_reply or ignore_event instead.',
        };
      }
      if (!adapter.postReaction) {
        return {
          success: false as const,
          error: 'Emoji reactions are unavailable on this surface.',
        };
      }
      const name = rawName.replace(/^:+|:+$/g, '');
      if (!name || /\s/.test(name)) {
        return { success: false as const, error: 'Invalid reaction name.' };
      }
      const messageId = currentMessageId ?? conversation.conversationId;
      const signature = JSON.stringify([name, purpose, messageId]);
      if (completedChatReactionSignatures.has(signature)) {
        return recordChatReaction(name, purpose, messageId, instructionVersion);
      }
      throwIfTurnCancelled();
      await adapter.postReaction({ name, purpose, messageId });
      return recordChatReaction(name, purpose, messageId, instructionVersion);
    };

    const reportInferenceRetry = async (
      notice: FastAgentInferenceRetryNotice,
    ) => {
      inferenceRetryAttempted = true;
      const message = formatFastAgentInferenceRetryNotice(notice);
      const reply = { purpose: 'progress' as const, message };

      // Silence is a presentation choice, not permission to keep recovery
      // entirely in memory. Persist the first retry immediately so an owner
      // crash during quiet backoff leaves a durable marker for the expired-
      // lease reconciler to turn into a terminal interruption.
      inferenceRetryCanonicalEvent ??= allocateCanonicalEvent(
        `retry-notice:${nextRetryNoticeOrdinal++}`,
      );
      // The marker's timestamp is the recovery episode's start. A run the
      // queue resumes inherits it, so the silent window keeps counting from
      // the first failure instead of restarting on every handoff.
      const now = Date.now();
      inferenceRecoveryEpisodeStartedAt ??= now;
      // The upsert replaces metadata, so a notice that is already visible
      // (posted by this run or inherited from a parked predecessor) keeps
      // its message id and visibility; otherwise a later run could not
      // find the message to edit and would post a second notice.
      await persistAssistantReply({
        reply,
        event: inferenceRetryCanonicalEvent,
        inferenceRetryNotice: true,
        visibleInTranscript: Boolean(inferenceRetryReply),
        platformMessageId: inferenceRetryReply?.messageId,
        ts: inferenceRecoveryEpisodeStartedAt,
      });

      if (platformEvent) return;

      // Stay silent while recovery is short enough that a standard task
      // would absorb it invisibly. A notice is only worth interrupting the
      // user for when the pending wait pushes the continuous no-progress
      // stretch past the silent window.
      const projectedRecoveryMs =
        now - inferenceRecoveryEpisodeStartedAt + (notice.delayMs ?? 0);
      if (projectedRecoveryMs < FAST_AGENT_SILENT_RECOVERY_WINDOW_MS) {
        return;
      }

      if (reportedInferenceNotices.has(message)) {
        return;
      }

      reportedInferenceNotices.add(message);
      // Deliberately not the postReply closure: a system retry notice must
      // not satisfy the model's acknowledgement gate or close the turn.
      if (!(await replaceInferenceRetryReply(reply))) {
        // A reply already streaming becomes the notice carrier rather than
        // leaving a cut-off draft above it.
        inferenceRetryReply =
          (await surfaceReplyStream.deliver(reply)) ??
          (await adapter.postReply(reply)) ??
          undefined;
        inferenceRetryMessageIndex = turnVisibleMessages.length;
        turnVisibleMessages.push(buildAssistantTextMessage(message));
        await persistAssistantReply({
          reply,
          event: inferenceRetryCanonicalEvent,
          platformMessageId: inferenceRetryReply?.messageId,
          inferenceRetryNotice: true,
          ts: inferenceRecoveryEpisodeStartedAt,
        });
      }
      diagnostics.recordVisibleReply({ assistantResponse: false });
    };
    const reportProviderRetryEvent = async (
      event: NonTaskProviderRetryEvent,
    ) => {
      diagnostics.recordOpenCodeProviderRetry(event.attempt, event.message);
      // OpenCode schedules its own internal backoff; include that pending
      // wait in the silent-window projection so an initial long stall
      // surfaces a notice without needing a later retry event.
      const pendingDelayMs =
        event.nextRetryAtMs !== undefined
          ? Math.max(0, event.nextRetryAtMs - Date.now())
          : undefined;
      await reportInferenceRetry({
        failure: classifyNonTaskInferenceError(new Error(event.message)),
        attemptNumber: event.attempt,
        ...(pendingDelayMs !== undefined ? { delayMs: pendingDelayMs } : {}),
      });
    };
    const reportRoomoteInferenceRetry = async (
      notice: FastAgentInferenceRetryNotice,
    ) => {
      diagnostics.recordRoomoteInferenceRetry();
      await reportInferenceRetry(notice);
    };

    const requireOpen = (messageId?: string) =>
      isInstructionClosed(getInstructionVersion(messageId))
        ? { success: false as const, error: 'This Fast turn is closed.' }
        : null;
    const throwIfTurnCancelled = () => {
      if (!signal?.aborted) return;
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('This Fast turn was canceled.');
    };
    const requireLockOwnership = () => {
      try {
        throwIfTurnCancelled();
        return null;
      } catch (error) {
        return toolFailure(error);
      }
    };
    // Single owner of the human-turn work-start gate, applied in-process to
    // every native and MCP tool call before it runs. Only text communication
    // (a reply, a first progress note, or a task kickoff) opens the gate; a
    // reaction never does. The listed tools are the ones allowed to precede
    // that communication.
    const acknowledgementExemptToolIds = new Set<string>([
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction,
      FAST_AGENT_NATIVE_TOOL_NAMES.launchTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      // A catalog lookup reads nothing external; the call it prepares for is
      // still gated on the acknowledgement.
      FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools,
      `${ROOMOTE_MCP_ID}_${CHAT_REACTION_EMOJI_TOOL_NAME}`,
    ]);
    const authorizeToolStart = (toolId: string) =>
      platformEvent ||
      substantiveWorkAcknowledged ||
      acknowledgementExemptToolIds.has(toolId)
        ? null
        : {
            success: false as const,
            error:
              'Post an acknowledgement with send_chat_reply before this action.',
          };

    const executeMcpTool = async (
      call: FastAgentMcpToolCall,
    ): Promise<unknown> => {
      activeToolExecutions += 1;
      let canonicalToolEvent:
        | Awaited<ReturnType<typeof beginCanonicalToolEvent>>
        | undefined;
      try {
        const closedError = requireOpen();
        if (closedError) return closedError;
        const ownershipError = requireLockOwnership();
        if (ownershipError) return ownershipError;
        nativeToolInvoked = true;
        turnProgressMarker += 1;
        // The acknowledgement gate runs before replay revocation: a refused
        // pre-ack call must leave the durable row recoverable.
        const startDenial = authorizeToolStart(
          `${call.integrationId}_${call.toolName}`,
        );
        if (startDenial) return startDenial;
        if (
          !isReplaySafeFastAgentMcpCall(call) &&
          !(await revokeDurableTurnReplay(
            `MCP call ${call.integrationId}/${call.toolName} is not replay-safe.`,
          ))
        ) {
          return { success: false, error: DURABLE_REVOKE_FAILED_TOOL_ERROR };
        }

        if (platformEventHandling === 'present_only') {
          return {
            success: false,
            error:
              'This platform event may only be presented to the user with a closeout.',
          };
        }

        const chatLookupProvider =
          call.integrationId === ROOMOTE_MCP_ID &&
          (call.toolName === CHAT_CHANNEL_MESSAGES_TOOL.name ||
            call.toolName === CHAT_MESSAGE_CONTEXT_TOOL.name) &&
          isFastAgentCommunicationConversation(conversation)
            ? conversation.surface
            : undefined;
        const integrationArguments =
          call.integrationId === ROOMOTE_MCP_ID &&
          call.toolName === CHAT_CHANNEL_MESSAGES_TOOL.name &&
          conversation.surface === 'slack' &&
          (typeof call.args.oldest !== 'string' ||
            call.args.oldest.trim().length === 0)
            ? {
                ...call.args,
                oldest: getFastAgentDefaultSlackHistoryOldest(
                  typeof call.args.latest === 'string'
                    ? call.args.latest
                    : undefined,
                ),
              }
            : call.args;
        const currentChatChannel = isFastAgentCommunicationConversation(
          conversation,
        )
          ? conversation.surface === 'slack'
            ? conversation.replyTarget.channelId
            : (conversation.replyTarget.threadId ??
              conversation.replyTarget.channelId)
          : undefined;
        const chatLookupArguments =
          chatLookupProvider &&
          currentChatChannel &&
          (typeof integrationArguments.channel !== 'string' ||
            integrationArguments.channel.trim().length === 0) &&
          (call.toolName !== CHAT_MESSAGE_CONTEXT_TOOL.name ||
            typeof integrationArguments.messageLink !== 'string' ||
            integrationArguments.messageLink.trim().length === 0)
            ? { ...integrationArguments, channel: currentChatChannel }
            : integrationArguments;
        const chatScopedIntegrationArguments = chatLookupProvider
          ? { ...chatLookupArguments, provider: chatLookupProvider }
          : chatLookupArguments;
        const actorScopedIntegrationArguments =
          call.integrationId === ROOMOTE_MCP_ID &&
          conversation.surface === 'slack'
            ? call.toolName === CHAT_CHANNELS_TOOL.name
              ? {
                  ...chatScopedIntegrationArguments,
                  slackTeamId: conversation.workspaceId,
                }
              : call.toolName === CHAT_CHANNEL_POST_TOOL_NAME
                ? {
                    ...chatScopedIntegrationArguments,
                    provider: 'slack',
                    slackTeamId: conversation.workspaceId,
                  }
                : call.toolName === CHAT_REACTION_EMOJI_TOOL_NAME
                  ? {
                      name: call.args.name,
                      provider: 'slack',
                      slackTeamId: conversation.workspaceId,
                      channel: conversation.replyTarget.channelId,
                      messageId:
                        currentMessageId ?? conversation.conversationId,
                    }
                  : chatScopedIntegrationArguments
            : chatScopedIntegrationArguments;
        const sendsChatReaction =
          call.integrationId === ROOMOTE_MCP_ID &&
          call.toolName === CHAT_REACTION_EMOJI_TOOL_NAME;
        const signature = buildIntegrationCallSignature({
          integrationId: call.integrationId,
          toolName: call.toolName,
          args: actorScopedIntegrationArguments,
        });
        if (integrationCallSignatures.has(signature)) {
          return {
            success: false,
            error: 'The same integration call already ran in this turn.',
          };
        }
        integrationCallSignatures.add(signature);
        throwIfTurnCancelled();
        canonicalToolEvent = await beginCanonicalToolEvent({
          title: call.toolName,
          args: actorScopedIntegrationArguments,
          mcpServerName: call.integrationId,
          mcpToolName: call.toolName,
        });
        const result = await callFastAgentIntegration(
          {
            userId,
            apiBaseUrl,
            sessionId: session.id,
            conversation,
            messageId: currentMessageId ?? conversation.conversationId,
          },
          availableIntegrations,
          {
            integrationId: call.integrationId,
            toolName: call.toolName,
            args: actorScopedIntegrationArguments,
          },
        );
        if (sendsChatReaction) {
          if (!isSuccessfulChatReactionResult(result)) {
            const failure = {
              success: false as const,
              error:
                result &&
                typeof result === 'object' &&
                typeof (result as { error?: unknown }).error === 'string'
                  ? (result as { error: string }).error
                  : 'Slack did not confirm the emoji reaction.',
            };
            await finishCanonicalToolEvent(canonicalToolEvent, failure);
            return failure;
          }
          const name =
            typeof call.args.name === 'string'
              ? call.args.name.trim().replace(/^:+|:+$/g, '')
              : '';
          await recordChatReaction(
            name,
            'ack',
            currentMessageId ?? conversation.conversationId,
          );
        }
        const response = { success: true, result };
        await finishCanonicalToolEvent(canonicalToolEvent, response);
        return response;
      } catch (error) {
        const failure = toolFailure(error);
        if (canonicalToolEvent) {
          await finishCanonicalToolEvent(canonicalToolEvent, failure);
        }
        return failure;
      } finally {
        activeToolExecutions -= 1;
        schedulePendingHumanSteerDrain();
      }
    };

    // Natively mounted servers are excluded from both the lookup and the
    // call path: their tools are already exposed by name, and the subagent
    // tool filter denies some of them, which the shared call path must not
    // bypass.
    const onDemandIntegrations = availableIntegrations.filter(
      (integration) => !isFastAgentNativeIntegration(integration.id),
    );
    const nativeIntegrationError = (integrationId: string) => ({
      success: false as const,
      error: `The "${integrationId}" server is mounted natively; call its tools directly by their ${integrationId}_ prefixed names.`,
    });
    const describeIntegrationTools = (
      args: z.infer<typeof findIntegrationToolsArgsSchema>,
    ) => {
      if (
        args.integrationId &&
        isFastAgentNativeIntegration(args.integrationId)
      ) {
        return nativeIntegrationError(args.integrationId);
      }
      const found = findFastAgentIntegrationTools(onDemandIntegrations, args);
      if (found.unknownIntegration) {
        return {
          success: false as const,
          error: `No on-demand deployment MCP server with id "${args.integrationId}" is available in fast mode.`,
        };
      }
      return {
        success: true as const,
        tools: found.tools,
        ...(found.truncated
          ? { guidance: INTEGRATION_TOOL_LOOKUP_TRUNCATED_GUIDANCE }
          : {}),
      };
    };
    // Subagents may look up and call on-demand deployment MCP tools; every
    // other Fast tool stays with the parent. Calls run through the parent's
    // MCP executor, so gating, duplicate detection, and auditing are shared.
    const executeSubagentNativeTool = async (
      call: FastAgentNativeToolCall,
    ): Promise<unknown> => {
      try {
        if (call.name === FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools) {
          return describeIntegrationTools(
            findIntegrationToolsArgsSchema.parse(call.args),
          );
        }
        if (call.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool) {
          const args = callIntegrationToolArgsSchema.parse(call.args);
          if (isFastAgentNativeIntegration(args.integrationId)) {
            return nativeIntegrationError(args.integrationId);
          }
          return await executeMcpTool({
            integrationId: args.integrationId,
            toolName: args.toolName,
            args: args.args ?? {},
          });
        }
      } catch (error) {
        return toolFailure(error);
      }
      return {
        success: false,
        error: 'That tool is reserved for the Fast parent agent.',
      };
    };
    const executeNativeToolInner = async (
      call: FastAgentNativeToolCall,
    ): Promise<unknown> => {
      const recordToolFinished = diagnostics.recordNativeToolStarted(call.name);
      const instructionVersion = getInstructionVersion(call.messageId);

      try {
        const closedError = requireOpen(call.messageId);
        if (closedError) return closedError;
        const ownershipError = requireLockOwnership();
        if (ownershipError) return ownershipError;
        nativeToolInvoked = true;
        turnProgressMarker += 1;
        // The acknowledgement gate runs before replay revocation: a refused
        // pre-ack call must leave the durable row recoverable.
        const startDenial = authorizeToolStart(call.name);
        if (startDenial) return startDenial;
        if (
          !isReplaySafeFastAgentNativeTool(call) &&
          !(await revokeDurableTurnReplay(
            `Native tool ${call.name} is not replay-safe.`,
          ))
        ) {
          return { success: false, error: DURABLE_REVOKE_FAILED_TOOL_ERROR };
        }

        if (
          platformEventHandling === 'present_only' &&
          call.name !== FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply
        ) {
          return {
            success: false,
            error:
              'This platform event may only be presented to the user with a closeout.',
          };
        }
        switch (call.name) {
          case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply: {
            const args = chatReplyArgsSchema.parse(call.args);
            if (args.message === undefined) await waitForSettledReplyText();
            const message = (
              args.message ?? replyTextTracker.unconsumedText()
            ).trim();
            if (!message) {
              return { success: false, error: FAST_AGENT_EMPTY_REPLY_ERROR };
            }
            if (
              args.suggestions?.length &&
              (args.purpose !== 'closeout' ||
                !platformEvent ||
                platformEventKind !== 'automation' ||
                !['slack', 'discord', 'teams', 'telegram'].includes(
                  conversation.surface,
                ))
            ) {
              return {
                success: false,
                error:
                  'Launchable suggestions are available only on chat automation closeouts.',
              };
            }
            const validSuggestionEnvironmentIds = new Set([
              ALL_REPOSITORIES,
              FAST_EXECUTION,
              ...availableEnvironments.map((environment) => environment.id),
            ]);
            if (
              args.suggestions?.some(
                (suggestion) =>
                  suggestion.environmentId &&
                  !validSuggestionEnvironmentIds.has(suggestion.environmentId),
              )
            ) {
              return {
                success: false,
                error:
                  'A suggested task selected an environment that was not found.',
              };
            }
            if (
              platformEventHandling === 'present_only' &&
              args.purpose !== 'closeout'
            ) {
              return {
                success: false,
                error: 'This platform event must be presented with a closeout.',
              };
            }
            if (
              platformEvent &&
              // On chat surfaces every reply is a separate message and push
              // notification, so automated events are held to one closeout.
              // Web platform events render in a session transcript where
              // extra replies are ordinary conversation; the prompt alone
              // governs reply style there (e.g. the setup kickoff's intro).
              conversation.surface !== 'web' &&
              args.purpose !== 'closeout' &&
              args.purpose !== 'clarification'
            ) {
              return {
                success: false,
                error:
                  'Platform events may post only a closeout or clarification.',
              };
            }
            const signature = JSON.stringify([
              args.purpose,
              message,
              args.imageArtifactIds ?? [],
              args.suggestions ?? [],
            ]);
            if (completedChatReplySignatures.has(signature)) {
              replyTextTracker.consumeUnconsumed();
              dropStreamedReply();
              await surfaceReplyStream.abort();
              return {
                success: true,
                delivered: true,
                duplicate: true,
                closed: isInstructionClosed(instructionVersion),
              };
            }
            throwIfTurnCancelled();
            // Whatever the model wrote before this call is delivered by it,
            // whether the call restates that text or leaves it implicit.
            replyTextTracker.consumeUnconsumed();
            const streamedEvent = await takeStreamedReplyEvent();
            await postReply(
              {
                purpose: args.purpose,
                message,
                ...(args.imageArtifactIds?.length
                  ? { imageArtifactIds: args.imageArtifactIds }
                  : {}),
                ...(args.suggestions?.length
                  ? { suggestions: args.suggestions }
                  : {}),
              },
              false,
              undefined,
              instructionVersion,
              streamedEvent,
            );
            completedChatReplySignatures.add(signature);
            return {
              success: true,
              delivered: true,
              closed: isInstructionClosed(instructionVersion),
            };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction: {
            const args = chatReactionArgsSchema.parse(call.args);
            return postChatReaction(
              args.name,
              args.purpose,
              instructionVersion,
            );
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.createArtifact: {
            if (!adapter.createArtifact) {
              return {
                success: false,
                error: 'Artifact creation is unavailable for this Session.',
              };
            }
            const args = createArtifactArgsSchema.parse(call.args);
            const signature = createHash('sha256')
              .update(`${args.path}\0${args.content}`)
              .digest('hex');
            if (completedTaskActions.has(`artifact:${signature}`)) {
              return {
                success: false,
                error: 'The same artifact was already created in this turn.',
              };
            }
            const extension = args.path.split('.').pop()?.toLowerCase();
            const inferredContentType =
              extension === 'md'
                ? 'text/markdown'
                : extension === 'html' || extension === 'htm'
                  ? 'text/html'
                  : extension === 'json'
                    ? 'application/json'
                    : extension === 'csv'
                      ? 'text/csv'
                      : extension === 'svg'
                        ? 'image/svg+xml'
                        : 'text/plain';
            completedTaskActions.add(`artifact:${signature}`);
            try {
              const artifact = await adapter.createArtifact({
                ...args,
                contentType: args.contentType ?? inferredContentType,
              });
              if (conversation.surface === 'web') visibleUpdatePosted = true;
              return {
                success: true,
                artifact,
                guidance: 'Link the artifact viewUrl when it is useful.',
              };
            } catch (error) {
              completedTaskActions.delete(`artifact:${signature}`);
              return toolFailure(error);
            }
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.showWidget: {
            const args = showWidgetArgsSchema.parse(call.args);
            const result = await prepareShowWidget(args);
            if (!result.success) {
              return result;
            }

            if (
              stringifyFastAgentToolOutput(result).length >
              ACP_UI_TOOL_OUTPUT_MAX_CHARS
            ) {
              return {
                success: false,
                error: `The sanitized widget exceeds the Fast transcript limit of ${ACP_UI_TOOL_OUTPUT_MAX_CHARS} characters.`,
              };
            }

            if (
              result.textFallback &&
              (conversation.surface === 'slack' ||
                conversation.surface === 'discord')
            ) {
              const signature = JSON.stringify([
                'progress',
                result.textFallback,
                [],
              ]);
              if (!completedChatReplySignatures.has(signature)) {
                throwIfTurnCancelled();
                await postReply({
                  purpose: 'progress',
                  message: `${result.textFallback}\n\n[View widget](${buildFastSessionUrl(conversation.surface, session.id)})`,
                });
                completedChatReplySignatures.add(signature);
              }
            } else if (conversation.surface === 'web') {
              visibleUpdatePosted = true;
            }

            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.launchTask: {
            const args = launchTaskArgsSchema.parse(call.args);
            const validEnvironmentIds = new Set([
              ALL_REPOSITORIES,
              ...availableEnvironments.map((environment) => environment.id),
            ]);
            if (
              args.environmentId &&
              !validEnvironmentIds.has(args.environmentId)
            ) {
              return {
                success: false,
                error: 'The selected environment was not found.',
              };
            }
            if (
              args.model &&
              !taskModelOptions.models.some((model) => model.id === args.model)
            ) {
              return {
                success: false,
                error: `Model "${args.model}" is not enabled for new tasks. Choose an exact ID from Available Delegated Task Models.`,
              };
            }
            try {
              await adapter.assertTaskLaunch?.();
            } catch (error) {
              return toolFailure(error);
            }
            const signature = `launch_task:${JSON.stringify([
              args.prompt,
              args.environmentId ?? null,
              args.model ?? null,
              args.includeAttachments,
            ])}`;
            if (completedTaskActions.has(signature)) {
              return {
                success: false,
                error: 'The same task was already launched in this turn.',
              };
            }
            completedTaskActions.add(signature);
            let kickoffDelivered = false;
            const deliverKickoff = async (task: {
              taskId: string;
              taskUrl?: string;
              taskLinkRendered?: boolean;
            }) => {
              let linkedSession: Awaited<ReturnType<typeof getSessionForTask>> =
                null;
              try {
                linkedSession = await getSessionForTask(db, task.taskId);
              } catch (error) {
                console.warn(
                  `[sessions] Failed to resolve Session kickoff link: ${formatErrorForLog(error)}`,
                );
              }
              const destinationUrl = linkedSession
                ? buildSelectedTaskSessionUrl({
                    taskUrl:
                      task.taskUrl ?? `${Env.R_APP_URL}/task/${task.taskId}`,
                    sessionId: linkedSession.id,
                    taskId: task.taskId,
                  })
                : task.taskUrl;
              // The delegated task's live Slack card owns the workspace
              // startup status; the kickoff is a permanent thread message
              // that nothing can update later, so it must not carry
              // transient "preparing" copy.
              const message = [
                args.kickoffMessage,
                destinationUrl &&
                !task.taskLinkRendered &&
                !args.kickoffMessage.includes(destinationUrl)
                  ? `[Open in Roomote](${destinationUrl})`
                  : undefined,
              ]
                .filter((part): part is string => Boolean(part))
                .join('\n\n');
              throwIfTurnCancelled();
              await postReply(
                { purpose: 'progress', message, kickoff: true },
                true,
              );
              kickoffDelivered = true;
            };
            throwIfTurnCancelled();
            const prompt = args.includeAttachments
              ? appendAttachmentTextsToPromptText({
                  text: args.prompt,
                  attachmentTexts,
                })
              : args.prompt;
            let result: Awaited<ReturnType<typeof adapter.launchTask>>;
            try {
              result = await adapter.launchTask({
                prompt,
                ...(args.includeAttachments && images.length > 0
                  ? { images }
                  : {}),
                environmentId: args.environmentId ?? null,
                model: args.model ?? null,
                parentSessionId: session.id,
                postKickoff: deliverKickoff,
              });
            } catch (error) {
              completedTaskActions.delete(signature);
              throw error;
            }
            if (!result.success) {
              // A failed launch created nothing, so the model may retry the
              // same task in this turn; keeping the signature would reject
              // the retry as a duplicate.
              completedTaskActions.delete(signature);
            }
            if (result.success) {
              currentTasks.set(result.taskId, { taskId: result.taskId });
              if (result.kickoffDelivered) {
                visibleUpdatePosted = true;
                substantiveWorkAcknowledged = true;
              }
              if (!kickoffDelivered && !result.kickoffDelivered) {
                await deliverKickoff(result);
              }
            }
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage: {
            const args = taskMessageArgsSchema.parse(call.args);
            const target = selectActiveTaskId(args.taskId, currentTasks);
            if (!target.taskId) return { success: false, error: target.error };
            const signature = `send_task_message:${target.taskId}`;
            if (completedTaskActions.has(signature)) {
              return {
                success: false,
                error: 'A message was already sent to that task this turn.',
              };
            }
            completedTaskActions.add(signature);
            throwIfTurnCancelled();
            const message = args.includeAttachments
              ? appendAttachmentTextsToPromptText({
                  text: args.message,
                  attachmentTexts,
                })
              : args.message;
            const result = await sendFastAgentTaskMessage(
              { userId, apiBaseUrl },
              {
                taskId: target.taskId,
                message,
                ...(args.includeAttachments && images.length > 0
                  ? { images }
                  : {}),
              },
            );
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask: {
            const args = taskIdArgsSchema.parse(call.args);
            const target = selectActiveTaskId(args.taskId, currentTasks);
            if (!target.taskId) return { success: false, error: target.error };
            const targetTask = currentTasks.get(target.taskId);
            if (
              targetTask?.status !== undefined &&
              !(activeRunStatuses as readonly RunStatus[]).includes(
                targetTask.status,
              )
            ) {
              return {
                success: false,
                error: `Task ${target.taskId} is not active in this conversation.`,
              };
            }
            const signature = `cancel_task:${target.taskId}`;
            if (completedTaskActions.has(signature)) {
              return {
                success: false,
                error: 'That task was already canceled.',
              };
            }
            completedTaskActions.add(signature);
            throwIfTurnCancelled();
            const result = await cancelFastAgentTask(
              { userId, apiBaseUrl },
              target.taskId,
            );
            if (result.success) {
              currentTasks.delete(target.taskId);
            }
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart: {
            if (!platformEvent || !adapter.retryTaskStart) {
              return {
                success: false,
                error: 'Task-start retry is unavailable for this turn.',
              };
            }
            if (retriedTaskStart) {
              return { success: false, error: 'Startup was already retried.' };
            }
            retriedTaskStart = true;
            throwIfTurnCancelled();
            return await adapter.retryTaskStart();
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.saveMemory: {
            const args = saveMemoryArgsSchema.parse(call.args);
            if (!(await isBrainEnabled())) {
              return {
                success: false,
                error: 'This deployment has no Brain configured.',
              };
            }
            throwIfTurnCancelled();
            const result = await appendFastAgentMemory(
              db,
              session.id,
              args.memory,
            );
            if (!result.saved) {
              return {
                success: false,
                error:
                  "This conversation's memory is full. Start a new conversation to save further memories.",
              };
            }
            return {
              success: true,
              saved: true,
              note: 'Saved. The memory becomes searchable after the next ingestion pass.',
            };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput: {
            if (conversation.surface !== 'web') {
              return {
                success: false,
                error: 'Structured input is available only in web Sessions.',
              };
            }
            const args = requestUserInputArgsSchema.parse(call.args);
            if (!args) {
              return {
                success: false,
                error: 'Pass either questions to ask or a trusted preset name.',
              };
            }
            const preset = 'preset' in args ? args.preset : undefined;
            if (preset && (!setupSession || !adapter.resolveUserInputPreset)) {
              return {
                success: false,
                error:
                  'That trusted input preset is unavailable in this session.',
              };
            }
            const questions =
              'questions' in args
                ? args.questions
                : await adapter.resolveUserInputPreset!(
                    args.preset as FastAgentInputPreset,
                  );
            for (const question of questions) {
              if (question.options && question.isSecret) {
                return {
                  success: false,
                  error:
                    'Secret questions must use free-text answers, not options.',
                };
              }
              if (question.multiple && !question.options) {
                return {
                  success: false,
                  error:
                    'Multi-select questions require options to choose from.',
                };
              }
            }
            const inputEvent = allocateCanonicalEvent(
              `input_request:${nextTurnSeq++}`,
            );
            const requestId = `rui:${inputEvent.eventId}`;
            throwIfTurnCancelled();
            await persistCanonicalMessage(
              {
                ...inputEvent,
                turnId,
                ts: Date.now(),
                eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
                role: 'assistant',
                contentBlocks: [
                  {
                    type: 'text',
                    text: questions
                      .map((question) => question.question)
                      .join('\n'),
                  },
                ],
                metadata: { visibleInTranscript: true },
                payload: {
                  requestId,
                  status: 'pending',
                  ...(preset ? { preset } : {}),
                  sessionId: session.id,
                  turnId,
                  callId: requestId,
                  questions,
                },
                source: conversation.surface,
                nativeSessionId: activeOpenCodeSessionId,
              },
              true,
            );
            await adapter.requestUserInput?.({
              requestId,
              ...(preset ? { preset } : {}),
              questions,
            });
            visibleUpdatePosted = true;
            closedInstructionVersions.add(instructionVersion);
            return { success: true, requestId, closed: true };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools: {
            return describeIntegrationTools(
              findIntegrationToolsArgsSchema.parse(call.args),
            );
          }
          case FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool: {
            const args = callIntegrationToolArgsSchema.parse(call.args);
            if (isFastAgentNativeIntegration(args.integrationId)) {
              return nativeIntegrationError(args.integrationId);
            }
            return executeMcpTool({
              integrationId: args.integrationId,
              toolName: args.toolName,
              args: args.args ?? {},
            });
          }
          case FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent: {
            ignoreEventArgsSchema.parse(call.args);
            if (platformEvent && platformEventVisibility === 'required') {
              return {
                success: false,
                error: 'This platform event requires a user-visible closeout.',
              };
            }
            if (!reactionInput && !platformEvent && !allowSilentAmbientReply) {
              return {
                success: false,
                error:
                  'Only a reaction, optional platform event, or eligible ambient human message may be ignored.',
              };
            }
            closedInstructionVersions.add(instructionVersion);
            return { success: true, ignored: true, closed: true };
          }
        }
      } catch (error) {
        return toolFailure(error);
      } finally {
        recordToolFinished();
      }
    };

    const executeNativeTool = async (
      call: FastAgentNativeToolCall,
    ): Promise<unknown> => {
      activeToolExecutions += 1;
      try {
        // The on-demand call is transport: the MCP executor it delegates to
        // records the integration tool event, which is what the transcript
        // should show, so no wrapper event is written for it.
        if (call.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool) {
          return await executeNativeToolInner(call);
        }
        const canonicalToolEvent = await beginCanonicalToolEvent({
          title: call.name,
          args: call.args,
          nativeSessionId: call.sessionId,
          kind: getFastAgentNativeAcpKind(call.name),
        });
        try {
          const result = await executeNativeToolInner(call);
          await finishCanonicalToolEvent(
            canonicalToolEvent,
            result,
            call.sessionId,
          );
          return result;
        } catch (error) {
          await finishCanonicalToolEvent(
            canonicalToolEvent,
            toolFailure(error),
            call.sessionId,
          );
          throw error;
        }
      } finally {
        activeToolExecutions -= 1;
        schedulePendingHumanSteerDrain();
      }
    };

    const imageFiles = getFastAgentImageFiles(images);
    const serializedTurnPrompt = serializeFastAgentMessages(turnMessages);
    let inferenceAttemptNumber = 0;
    const persistOpenCodeSession = async (openCodeSessionId: string) => {
      if (durableOpenCodeSessionId === openCodeSessionId) return;
      await setFastAgentOpenCodeSession({
        sessionId: session.id,
        openCodeSessionId,
      });
      durableOpenCodeSessionId = openCodeSessionId;
      session.openCodeSessionId = openCodeSessionId;
    };
    diagnostics.markInferenceQueued();
    const promptTextPromise = fastAgentOpenCodeSessionManager.run({
      conversationId: session.id,
      persistedSessionId: session.openCodeSessionId,
      prompt: serializedTurnPrompt,
      bootstrapPrompt: () =>
        serializeFastAgentMessages([
          ...bootstrapMessages,
          ...injectedHumanFollowUpMessages,
        ]),
      onPathSelected: (path) => {
        diagnostics.recordSessionPath(path);
        console.info(`[Fast Agent] OpenCode session path=${path}.`);
      },
      execute: async (
        openCodeSession,
        selectedPrompt,
        { path: sessionPath, validateSession },
      ) => {
        diagnostics.markInferenceSetupStarted();
        const spillBudget = createFastAgentSpillTurnBudget();
        const skillStore = new FastAgentSkillStore(
          undefined,
          new RemoteFastAgentRepositorySkillSource({
            allowedEnvironmentIds: availableEnvironments.map(
              (environment) => environment.id,
            ),
          }),
          new RemoteFastAgentSettingsSkillSource({
            allowedEnvironmentIds: availableEnvironments.map(
              (environment) => environment.id,
            ),
          }),
        );
        const nativeRuntime = await getFastAgentNativeToolRuntime(
          session.id,
          availableIntegrations,
          { surface: conversation.surface },
        );
        const unbindExecutors = new Set<() => void>();
        const boundSubagentSessionIDs = new Set<string>();
        const unbindAllExecutors = () => {
          for (const unbind of unbindExecutors) unbind();
          unbindExecutors.clear();
          boundSubagentSessionIDs.clear();
        };
        let promptForAttempt = selectedPrompt;
        let imageFilesForAttempt =
          sessionPath === 'fallback_rebuild'
            ? [...imageFiles, ...injectedHumanFollowUpFiles]
            : imageFiles;
        let promptKind: FastAgentPromptKind =
          sessionPath === 'warm' || sessionPath === 'cold_resume'
            ? 'turn_delta'
            : 'bootstrap';
        let attemptSessionPath = sessionPath;
        let promptTimeoutMs: number | null = null;
        let resolvedInferenceModel: string | undefined;
        const captureInferenceContext = (
          attemptScope: 'prompt_submission' | 'provider_retry',
          providerRetryAttempt?: number,
        ) => {
          captureFastAgentInferenceContext({
            userId,
            sessionId: session.id,
            turnId,
            systemPrompt: system,
            surface: conversation.surface,
            turnSource,
            platformEventHandling,
            platformEventKind,
            sessionPath: attemptSessionPath,
            promptKind,
            attemptNumber: inferenceAttemptNumber,
            attemptScope,
            providerRetryAttempt,
            releasePresent: Boolean(releaseVersion),
            environmentCount: availableEnvironments.length,
            taskModelCount: taskModelOptions.models.length,
            activeTaskCount: resolvedActiveTasks.length,
            integrationCount: availableIntegrations.length,
            integrationToolCount: availableIntegrations.reduce(
              (count, integration) => count + integration.tools.length,
              0,
            ),
            memoryIntegrationCount: availableIntegrations.filter(
              (integration) => isMemoryMcpServer(integration.id),
            ).length,
            compatibilityMessageCount: session.compatibilityMessages.length,
            suppliedThreadMessageCount: threadContext.length,
            threadContextAttached:
              promptKind === 'bootstrap' ||
              promptKind === 'clean_retry_bootstrap'
                ? bootstrapThreadContextPresent
                : promptKind === 'turn_delta'
                  ? turnThreadContextPresent
                  : false,
            senderContextPresent: Boolean(
              currentMessageSender?.slackUserId ||
              currentMessageSender?.displayName ||
              currentMessageSender?.githubLogin,
            ),
            agentContextPresent: Boolean(currentMessageAgentContext),
            inputImageCount: imageFiles.length,
            attachedImageCount: imageFilesForAttempt.length,
            degradedComponents: [...degradedContextComponents],
          });
        };
        const unbindMcpExecutor = bindFastAgentMcpToolExecutor(
          nativeRuntime.mcpCapability,
          executeMcpTool,
        );
        try {
          if (signal) {
            markFastAgentShutdownCloseoutPending(signal);
          }
          const result = await runFastAgentInferenceWithRetries(
            async () => {
              const providerRetryAbortController = new AbortController();
              const closeoutAbortController = new AbortController();
              const promptSignal = AbortSignal.any([
                ...(signal ? [signal] : []),
                providerRetryAbortController.signal,
                closeoutAbortController.signal,
              ]);
              let providerRetryTimeout:
                | ReturnType<typeof setTimeout>
                | undefined;
              const attemptStartedAt = Date.now();
              let promptStarted = false;
              let providerRetryEventCount = 0;
              try {
                inferenceAttemptNumber += 1;
                resolvedInferenceModel = undefined;
                captureInferenceContext('prompt_submission');
                const resultPromise =
                  generateTrackedNonTaskTextInOpenCodeSession(
                    {
                      userId,
                      fastConversationId: session.id,
                      surface:
                        NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
                      modelRole: FAST_AGENT_MODEL_ROLE,
                      ...(model ? { model } : {}),
                      ...(reasoningEffort ? { reasoningEffort } : {}),
                      timeoutMs: promptTimeoutMs,
                      maxProviderRetryAttempts:
                        FAST_AGENT_INFERENCE_MAX_RETRIES,
                      system,
                      prompt: promptForAttempt,
                      onProviderRetry: async (event) => {
                        providerRetryEventCount += 1;
                        captureInferenceContext(
                          'provider_retry',
                          event.attempt,
                        );
                        // Initial turns stay unbounded unless the provider enters
                        // recovery. Start this deadline once so repeated provider
                        // retry events cannot extend the conversation lock.
                        if (
                          promptTimeoutMs === null &&
                          providerRetryTimeout === undefined
                        ) {
                          providerRetryTimeout = setTimeout(() => {
                            providerRetryAbortController.abort(
                              new NonTaskOpenCodePromptTimeoutError(
                                FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS,
                              ),
                            );
                          }, FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS);
                          providerRetryTimeout.unref();
                        }
                        await reportProviderRetryEvent(event);
                        // OpenCode is about to sleep out its own backoff
                        // inside this process, which is the wait a restart
                        // interrupts most often. A replay-safe turn parks
                        // at that time instead and lets the queue re-prompt;
                        // the abort below ends this prompt with the park as
                        // its reason. The horizon and handoff cap bound the
                        // parks, after which OpenCode's in-process retries
                        // resume.
                        if (event.nextRetryAtMs !== undefined) {
                          const parkedUntil = await deferInferenceRetry({
                            failure: classifyNonTaskInferenceError(
                              new Error(event.message),
                            ),
                            attemptNumber: durableRetriesConsumed + 1,
                            delayMs: Math.max(
                              0,
                              event.nextRetryAtMs - Date.now(),
                            ),
                            inProcessAttempt: event.attempt,
                          });
                          if (parkedUntil) {
                            providerRetryAbortController.abort(
                              new FastAgentDurableRetryScheduledError(
                                parkedUntil,
                              ),
                            );
                          }
                        }
                      },
                      ...(imageFilesForAttempt.length
                        ? {
                            files: imageFilesForAttempt,
                            requiredInputModality: 'image' as const,
                          }
                        : {}),
                    },
                    openCodeSession,
                    {
                      directory: nativeRuntime.directory,
                      env: nativeRuntime.env,
                      permission: FAST_AGENT_SESSION_PERMISSIONS,
                      signal: promptSignal,
                      promptOnlySubagents: true,
                      trackSessionTreeUsage: true,
                      validateSession,
                      // The generated build-agent config owns the parent tool
                      // allowlist. Persist only explicit built-in restrictions
                      // so warm sessions shed the old wildcard deny and child
                      // sessions do not inherit it.
                      tools: FAST_AGENT_SESSION_TOOL_FILTER,
                      onModelResolved: (model) => {
                        resolvedInferenceModel = model;
                        diagnostics.recordModelResolved(model);
                      },
                      onMessageCompleted: (message) => {
                        diagnostics.recordAssistantMessageCompleted(message);
                        completedOpenCodeMessage = message;
                        completedOpenCodeInstructionVersion =
                          getInstructionVersion(message.id ?? undefined);
                        // A completed assistant message is provider progress:
                        // it restarts the silent-recovery window and lets a
                        // later failure earn a refreshed retry budget.
                        turnProgressMarker += 1;
                        noteInferenceRecoveryProgress();
                      },
                      onAssistantMessageStarted: async (
                        message: NonTaskOpenCodeAssistantMessage,
                      ) => {
                        diagnostics.recordAssistantMessageStarted();
                        assistantInstructionVersions.set(
                          message.id,
                          currentInstructionVersion,
                        );
                        if (!isInstructionClosed()) return;
                        // A model request starting after the closeout is the
                        // trailing request that only ever produces unseen
                        // text. Let an in-flight steer drain land first: a
                        // queued follow-up reopens the turn instead.
                        await activeHumanSteerPoll.catch(() => undefined);
                        if (
                          !isInstructionClosed() ||
                          activeToolExecutions > 0 ||
                          closeoutAbortController.signal.aborted
                        ) {
                          return;
                        }
                        diagnostics.recordCloseoutAbort();
                        closeoutAbortController.abort(
                          new FastAgentTurnClosedError(),
                        );
                      },
                      onAssistantMessageCompleted: (message) => {
                        diagnostics.recordAssistantMessageCompleted(message);
                        return schedulePendingHumanSteerDrain();
                      },
                      onPromptStarted: (setupTiming) => {
                        promptStarted = true;
                        diagnostics.markInferenceStarted();
                        diagnostics.recordInferenceSetupTiming(setupTiming);
                      },
                      onNativeSteerReady: (steer) => {
                        nativeSteer = steer;
                        // The prompt becoming active is the first native
                        // pickup boundary. Messages admitted during setup are
                        // already accumulated and can be submitted together.
                        schedulePendingHumanSteerDrain();
                      },
                      onNativeSteerClosed: () => {
                        nativeSteer = undefined;
                      },
                      onSessionReady: async (openCodeSessionID) => {
                        activeOpenCodeSessionId = openCodeSessionID;
                        diagnostics.recordOpenCodeSessionReady(
                          openCodeSessionID,
                        );
                        unbindAllExecutors();
                        unbindExecutors.add(
                          bindFastAgentNativeToolExecutor(
                            openCodeSessionID,
                            session.id,
                            executeNativeTool,
                            {
                              allowSkillAccess: true,
                              allowSpillRecovery: true,
                              skillStore,
                              spillBudget,
                            },
                          ),
                        );
                      },
                      onSubagentSessionReady: (subagentSessionID) => {
                        if (boundSubagentSessionIDs.has(subagentSessionID))
                          return;
                        boundSubagentSessionIDs.add(subagentSessionID);
                        unbindExecutors.add(
                          bindFastAgentNativeToolExecutor(
                            subagentSessionID,
                            session.id,
                            executeSubagentNativeTool,
                            {
                              allowSkillAccess: false,
                              allowSpillRecovery: false,
                              skillStore,
                              spillBudget,
                            },
                          ),
                        );
                      },
                      onParentTaskPartUpdated: persistOpenCodeTaskPart,
                      onAssistantTextUpdated,
                    },
                  );
                const result = await resultPromise;
                noteInferenceRecoveryProgress();
                captureFastAgentInferenceAttemptOutcome({
                  userId,
                  sessionId: session.id,
                  turnId,
                  surface: conversation.surface,
                  sessionPath: attemptSessionPath,
                  promptKind,
                  attemptNumber: inferenceAttemptNumber,
                  outcome: 'success',
                  stage: !resolvedInferenceModel
                    ? 'model_resolution'
                    : promptStarted
                      ? 'model_generation'
                      : 'opencode_setup',
                  elapsedMs: Date.now() - attemptStartedAt,
                  resolvedModel: resolvedInferenceModel,
                  providerRetryEventCount,
                });
                return result;
              } catch (error) {
                if (closeoutAbortController.signal.aborted) {
                  // The visible closeout already went out; the aborted
                  // request was the trailing one. The turn is complete.
                  captureFastAgentInferenceAttemptOutcome({
                    userId,
                    sessionId: session.id,
                    turnId,
                    surface: conversation.surface,
                    sessionPath: attemptSessionPath,
                    promptKind,
                    attemptNumber: inferenceAttemptNumber,
                    outcome: 'success',
                    stage: 'model_generation',
                    elapsedMs: Date.now() - attemptStartedAt,
                    resolvedModel: resolvedInferenceModel,
                    providerRetryEventCount,
                  });
                  return '';
                }
                // A parked turn ended this prompt on purpose; the outer
                // handler records the outcome, not a failed attempt.
                const parked = findFastAgentDurableRetryScheduledError(error);
                if (parked) throw parked;
                const failure = classifyNonTaskInferenceError(error);
                const attemptStage = !resolvedInferenceModel
                  ? 'model_resolution'
                  : promptStarted
                    ? 'model_generation'
                    : 'opencode_setup';
                const attemptElapsedMs = Date.now() - attemptStartedAt;
                captureFastAgentInferenceAttemptOutcome({
                  userId,
                  sessionId: session.id,
                  turnId,
                  surface: conversation.surface,
                  sessionPath: attemptSessionPath,
                  promptKind,
                  attemptNumber: inferenceAttemptNumber,
                  outcome: 'failure',
                  stage: attemptStage,
                  elapsedMs: attemptElapsedMs,
                  failureReason: failure.reason,
                  failureRetryable: failure.retryable,
                  resolvedModel: resolvedInferenceModel,
                  providerRetryEventCount,
                });
                diagnostics.recordInferenceAttemptFailure({
                  attemptNumber: inferenceAttemptNumber,
                  promptKind,
                  stage: attemptStage,
                  elapsedMs: attemptElapsedMs,
                  reason: failure.reason,
                  retryable: failure.retryable,
                  providerRetryEventCount,
                  error,
                });
                throw error;
              } finally {
                if (providerRetryTimeout) {
                  clearTimeout(providerRetryTimeout);
                }
              }
            },
            reportRoomoteInferenceRetry,
            {
              // OpenCode owns retries while a provider turn remains active.
              // After a terminal failure, continue an intact session when
              // tools already ran; otherwise rebuild from visible history so
              // the original user turn is not appended twice.
              canRetry: (error) =>
                !signal?.aborted &&
                !isInstructionClosed() &&
                (!nativeToolInvoked || openCodeSession.id !== undefined) &&
                !isNonTaskOpenCodePromptTimeoutError(error) &&
                !isNonTaskOpenCodeSessionValidationError(error),
              // Grant a fresh bounded budget only when the failed attempt
              // advanced the turn and the next retry continues the same
              // OpenCode session. Cold rebuilds replay from scratch, so
              // resetting there could loop on the same later failure.
              consumeRetryBudgetReset: () => {
                if (turnProgressMarker === consumedProgressMarker) {
                  return false;
                }
                consumedProgressMarker = turnProgressMarker;
                if (!nativeToolInvoked || openCodeSession.id === undefined) {
                  return false;
                }
                noteInferenceRecoveryProgress();
                return true;
              },
              prepareRetry: () => {
                if (nativeToolInvoked && openCodeSession.id) {
                  promptForAttempt = FAST_AGENT_PROVIDER_RECOVERY_PROMPT;
                  imageFilesForAttempt = [];
                  promptKind = 'side_effect_retry_recovery';
                } else {
                  // OpenCode persists the user message before inference starts.
                  // Before tools run, rebuild from visible history rather than
                  // append the original turn to the failed session again.
                  openCodeSession.id = undefined;
                  promptForAttempt = serializeFastAgentMessages([
                    ...bootstrapMessages,
                    ...injectedHumanFollowUpMessages,
                  ]);
                  imageFilesForAttempt = [
                    ...imageFiles,
                    ...injectedHumanFollowUpFiles,
                  ];
                  promptKind = 'clean_retry_bootstrap';
                  attemptSessionPath = 'cold_rebuild';
                  diagnostics.recordSessionPath(attemptSessionPath);
                }
                // Keep every recovery attempt bounded so it cannot hold the
                // conversation lock forever if the provider stalls again.
                promptTimeoutMs = FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS;
              },
              deferRetry: deferInferenceRetry,
              signal,
            },
          );
          if (openCodeSession.id) {
            try {
              await persistOpenCodeSession(openCodeSession.id);
            } catch (error) {
              console.error(
                `[Fast Agent] Failed to persist OpenCode session identity: ${formatErrorForLog(error)}`,
              );
            }
          }
          return result;
        } finally {
          unbindAllExecutors();
          unbindMcpExecutor();
          await skillStore.dispose();
        }
      },
    });
    const promptText = await promptTextPromise.finally(() => {
      diagnostics.markInferenceFinished();
    });

    throwIfTurnCancelled();
    const terminalInstructionVersion =
      completedOpenCodeInstructionVersion ?? currentInstructionVersion;
    if (
      terminalInstructionVersion === currentInstructionVersion &&
      !isInstructionClosed(terminalInstructionVersion)
    ) {
      const message = resolveTerminalReplyText(promptText).trim();
      // A terminal closeout is itself a side effect a replay would repeat:
      // withdraw the turn from recovery before posting it.
      const terminalReplayRevoked =
        await revokeDurableTurnReplay('Terminal closeout.');
      if (!terminalReplayRevoked) {
        terminalRevocationFailed = true;
        console.warn(
          '[Fast Agent] Skipping the terminal closeout because the turn could not be withdrawn from replay.',
        );
      } else if (message) {
        const streamedEvent = await takeStreamedReplyEvent();
        await postReply(
          { purpose: 'closeout', message },
          false,
          completedOpenCodeMessage,
          terminalInstructionVersion,
          streamedEvent,
        );
      } else if (!visibleUpdatePosted) {
        // A delivered update is already a complete visible response. Stay
        // silent rather than append a generic closeout that contradicts it.
        await postReply(
          {
            purpose: 'closeout',
            message:
              'I could not complete that request within the available turn.',
          },
          false,
          undefined,
          terminalInstructionVersion,
        );
      } else if (platformEvent && platformEventVisibility === 'required') {
        // A visibility-required platform event promises a closeout even when
        // an intro ack or launch kickoff already posted a visible update
        // (e.g. the setup kickoff ending on an empty terminal response).
        await postReply(
          {
            purpose: 'closeout',
            message: 'I will post updates here as this progresses.',
          },
          false,
          undefined,
          terminalInstructionVersion,
        );
      }
    }
    await settleDurableTurn();
    await mirrorPendingMessages();
    return lastVisibleMessage;
  } catch (error) {
    if (error instanceof FastAgentDurableRetryScheduledError) {
      // The turn is parked, not failed: its notice stays active for the
      // resumed run to edit, its row waits for the scheduled time, and no
      // closeout is owed by this execution. The process-local OpenCode
      // session is dropped because the resumed run rebuilds from history.
      diagnostics.recordFailure('cancelled', error);
      if (canonicalConversationId) {
        fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
      }
      throw error;
    }
    const terminalError =
      signal?.aborted && signal.reason instanceof Error ? signal.reason : error;
    diagnostics.recordFailure(
      signal?.aborted
        ? 'cancelled'
        : error instanceof FastAgentInferenceError
          ? error.failure.reason
          : 'unclassified',
      terminalError,
    );
    if (signal?.aborted) {
      const shutdownInterrupted =
        terminalError instanceof FastAgentProcessShutdownError;
      const lockOwnershipLost =
        terminalError instanceof FastAgentTurnLockLostError;
      const interruptionReason: FastAgentInterruptionReason =
        shutdownInterrupted
          ? 'api_shutdown'
          : lockOwnershipLost
            ? 'lock_lost'
            : 'turn_aborted';
      // Only ownership losses the turn did not choose (a restart, a lost
      // conversation lock) are resumable; a deliberate cancellation is not.
      const resumable =
        durableTurnReplayable &&
        Boolean(durableAdmission) &&
        (shutdownInterrupted || lockOwnershipLost);
      console.error(
        `[Fast Agent] Turn interrupted (reason=${interruptionReason}, conversation=${canonicalConversationId ?? 'unknown'}, retryNoticeVisible=${Boolean(inferenceRetryReply)}, resumable=${resumable}, error=${formatErrorForLog(terminalError)})`,
      );
      try {
        if (canonicalConversationId) {
          fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
        }
        if (resumable && durableAdmission) {
          // Hand the turn back to the durable queue instead of the user: the
          // claim release makes the row eligible at once, the wake hint asks
          // the queue not to wait for its sweep, and no closeout is posted
          // because the resumed run will deliver the real answer.
          durableTurnReplayable = false;
          await releaseFastAgentDurableTurnClaim(
            durableAdmission.eventId,
          ).catch((releaseError) => {
            console.warn(
              `[Fast Agent] Failed to release durable turn claim: ${formatErrorForLog(releaseError)}`,
            );
          });
          await adapter.requestDurableResume?.().catch((wakeError) => {
            console.warn(
              `[Fast Agent] Failed to wake durable turn resume: ${formatErrorForLog(wakeError)}`,
            );
          });
        }
        // A terminal interruption closeout is only safe once the row can no
        // longer be re-run; if that revocation did not land, post nothing
        // and let recovery own the outcome.
        const terminalCloseoutAllowed =
          resumable || !durableAdmission
            ? !resumable
            : await revokeDurableTurnReplay(
                `Turn interrupted without replay (${interruptionReason}).`,
              );
        if (!terminalCloseoutAllowed) {
          // Resumable turns and unrevoked rows fall through to the rethrow
          // below without a user-facing closeout.
        } else if (!lockOwnershipLost && inferenceRetryReply) {
          await replaceInferenceRetryReply(
            {
              purpose: 'closeout',
              // A shutdown is a restart the user can see through honestly;
              // other aborts keep the generic retry-interruption wording.
              message: shutdownInterrupted
                ? RESTARTED_ACTIVE_TURN_MESSAGE
                : INTERRUPTED_INFERENCE_RETRY_MESSAGE,
            },
            true,
            undefined,
            interruptionReason,
          );
        } else if (shutdownInterrupted && !isInstructionClosed()) {
          const reply = {
            purpose: 'closeout' as const,
            message: RESTARTED_ACTIVE_TURN_MESSAGE,
          };
          try {
            const posted =
              (await surfaceReplyStream.deliver(reply)) ??
              (await adapter.postReply(reply));
            diagnostics.recordVisibleReply();
            const retryEvent = inferenceRetryCanonicalEvent;
            await persistAssistantReply({
              reply,
              event:
                retryEvent ??
                allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
              platformMessageId: posted?.messageId,
              inferenceRetryNotice: Boolean(retryEvent),
              interruptionReason,
            });
          } catch (postError) {
            console.error(
              `[Fast Agent] Failed to post shutdown closeout: ${formatErrorForLog(postError)}`,
            );
          }
        } else if (
          lockOwnershipLost &&
          canonicalConversationId &&
          inferenceRetryCanonicalEvent
        ) {
          // This owner is fenced off from terminal writes, but the fill-only
          // cause stamp is safe: it no-ops once a successor reconciles the
          // notice, and the reconciler folds it into its later closeout.
          await markFastAgentInferenceRetryNoticeInterruption(
            canonicalConversationId,
            inferenceRetryCanonicalEvent.eventId,
            'lock_lost',
          ).catch((markError) => {
            console.warn(
              `[Fast Agent] Failed to record lock-lost interruption cause: ${formatErrorForLog(markError)}`,
            );
          });
        }
      } finally {
        if (shutdownInterrupted) {
          markFastAgentShutdownCloseoutSettled(signal);
        }
      }
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    if (canonicalConversationId) {
      // The system-posted closeout below is mirrored to compatibility history,
      // not to OpenCode's live transcript. Force the next turn to bootstrap so
      // the model can see the failure the user saw in Slack or Discord.
      fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
    }
    if (platformEvent) throw error;

    const message =
      error instanceof FastAgentInferenceError
        ? formatFastAgentInferenceFailure(
            error.failure,
            inferenceRetryAttempted,
          )
        : 'I hit an error while handling that request. Please try again in a moment.';
    // The error closeout is terminal too; a replay must not post it twice.
    const errorReplayRevoked =
      !isInstructionClosed() &&
      (await revokeDurableTurnReplay('Error closeout.'));
    if (!isInstructionClosed() && !errorReplayRevoked) {
      terminalRevocationFailed = true;
      console.warn(
        '[Fast Agent] Skipping the error closeout because the turn could not be withdrawn from replay.',
      );
    }
    if (errorReplayRevoked) {
      try {
        const reply = { purpose: 'closeout' as const, message };
        if (
          !(await replaceInferenceRetryReply(reply, true, () =>
            diagnostics.recordVisibleReply(),
          ))
        ) {
          const posted =
            (await surfaceReplyStream.deliver(reply)) ??
            (await adapter.postReply(reply));
          diagnostics.recordVisibleReply();
          turnVisibleMessages.push(buildAssistantTextMessage(message));
          await persistAssistantReply({
            reply,
            event: allocateCanonicalEvent(
              `assistant:${nextAssistantOrdinal++}`,
            ),
            platformMessageId: posted?.messageId,
          });
        }
        inferenceRetryReply = undefined;
        inferenceRetryMessageIndex = undefined;
        inferenceRetryCanonicalEvent = undefined;
        lastVisibleMessage = message;
      } catch (postError) {
        console.error(
          `[Fast Agent] Failed to post error closeout: ${formatErrorForLog(postError)}`,
        );
      }
    }
    if (canonicalConversationId) {
      try {
        await appendFastAgentVisibleMessages({
          sessionId: canonicalConversationId,
          messages: turnVisibleMessages.slice(mirroredMessageCount),
        });
      } catch (mirrorError) {
        console.error(
          `[Fast Agent] Failed to mirror error closeout: ${formatErrorForLog(mirrorError)}`,
        );
      }
    }
    await settleDurableTurn();
    return lastVisibleMessage || message;
  } finally {
    if (respondingLeaseRenewalTimer) clearInterval(respondingLeaseRenewalTimer);
    respondingLeaseRenewalTimer = undefined;
    // Wait out any renewal already in flight so the terminal lease write
    // below cannot be overwritten by a stale extension.
    await respondingLeaseRenewal;
    signal?.removeEventListener('abort', stopHumanSteerPolling);
    stopHumanSteerPolling();
    await activeHumanSteerPoll;
    // Once Redis reports ownership loss, this invocation is fenced off from
    // the canonical lease/retry state below. A successor may already own and
    // have renewed the Session lease; clearing it or reconciling the prior
    // retry here would let the stale owner write an interruption over the
    // successor. The new owner reconciles on entry, or the lease-gated
    // scheduled reconciler repairs the marker later when no successor appears.
    const lockOwnershipLost =
      signal?.aborted && signal.reason instanceof FastAgentTurnLockLostError;
    // A parked turn is still responding from the user's point of view: the
    // lease and the active retry notice carry over to the scheduled run.
    if (canonicalConversationId && !lockOwnershipLost && !durableTurnDeferred) {
      await setFastSessionResponding(canonicalConversationId, false).catch(
        (error) => {
          console.warn(
            `[sessions] Failed to settle Fast Session status: ${formatErrorForLog(error)}`,
          );
        },
      );
      if (inferenceRetryAttempted) {
        await reconcileFastAgentInferenceRetryNotices(
          canonicalConversationId,
          'turn_settled_reconcile',
        ).catch((error) => {
          console.warn(
            `[Fast Agent] Failed to reconcile settled inference retry notices: ${formatErrorForLog(error)}`,
          );
        });
      }
    }
    dropStreamedReply();
    // A stream no reply finished (a cancelled or parked turn) is closed so
    // Slack stops showing it as still writing; its text stays.
    await surfaceReplyStream.abort();
    await replyStream.dispose();
    await adapter.activity?.settle().catch((error) => {
      console.warn(
        `[Fast Agent] Failed to settle surface activity: ${formatErrorForLog(error)}`,
      );
    });
    diagnostics.finish();
  }
}

export { FAST_AGENT_MODEL_ROLE };
export type { RoutableEnvironment };

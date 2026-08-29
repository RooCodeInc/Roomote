import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  ALL_REPOSITORIES,
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  FAST_AGENT_MEMORY_FACT_MAX_CHARS,
  INFERENCE_PROVIDER_MAX_RETRIES,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  ROOMOTE_MCP_ID,
  activeRunStatuses,
  buildInferenceProviderRecoveryPrompt,
  formatErrorForLog,
  resolveInferenceProviderRetryDelayMs,
  isMemoryMcpServer,
  truncateAcpOutputText,
  type ReasoningEffort,
  type RunStatus,
  type TaskMessageContentBlock,
} from '@roomote/types';
import {
  appendFastAgentMemory,
  db,
  getDeploymentTaskModelOptions,
  getSessionForFastConversation,
  getSessionForTask,
  isBrainEnabled,
  touchSessionActivity,
} from '@roomote/db/server';
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
import { getAvailableEnvironments, type RoutableEnvironment } from '../router';
import {
  FAST_AGENT_MODEL_ROLE,
  FAST_RESPONDING_LEASE_MS,
} from './fast-agent-constants';
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
  generateTrackedNonTaskTextInOpenCodeSession,
  isNonTaskOpenCodePromptTimeoutError,
  isNonTaskOpenCodeSessionNotFoundError,
  isNonTaskOpenCodeSessionValidationError,
  NonTaskOpenCodePromptTimeoutError,
  NON_TASK_INFERENCE_SURFACES,
  type NonTaskPromptFile,
  type NonTaskProviderRetryEvent,
  type NonTaskOpenCodeCompletedMessage,
} from '../non-task-provider-usage';
import { fastAgentOpenCodeSessionManager } from './fast-agent-opencode-session';
import {
  INTERRUPTED_INFERENCE_RETRY_MESSAGE,
  reconcileFastAgentInferenceRetryNotices,
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
  buildFastAgentToolFilter,
  getFastAgentNativeAcpKind,
} from './fast-agent-tool-policy';
import {
  callFastAgentIntegration,
  listFastAgentIntegrations,
} from './fast-agent-integration-broker';
import {
  cancelFastAgentTask,
  sendFastAgentTaskMessage,
} from './fast-agent-tasks';
import { getFastAgentUserIdentity } from './fast-agent-user-identity';
import { FastAgentTurnDiagnostics } from './fast-agent-turn-diagnostics';
import {
  captureFastAgentInferenceAttemptOutcome,
  captureFastAgentInferenceContext,
  type FastAgentPromptKind,
} from './fast-agent-context-telemetry';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import { FastAgentSkillStore } from './fast-agent-skill-store';
import {
  type FastAgentConversation,
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

export type FastAgentThreadMessage = SlackThreadPromptMessage;

const chatReplyArgsSchema = z.object({
  message: z.string().trim().min(1),
  purpose: z.enum(['ack', 'progress', 'closeout', 'clarification']),
  imageArtifactIds: z.array(z.string()).optional(),
  suggestions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(140),
        brief: z.string().trim().min(1).max(2000),
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
const FAST_AGENT_DEFAULT_SLACK_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const FAST_AGENT_CANONICAL_TOOL_OUTPUT_MAX_CHARS = 50_000;

async function setFastSessionResponding(
  fastConversationId: string,
  responding: boolean,
): Promise<void> {
  const session = await getSessionForFastConversation(db, fastConversationId);
  if (!session) return;
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

function buildFastAgentUserContentBlocks(
  text: string,
  images: string[],
): TaskMessageContentBlock[] {
  const blocks: TaskMessageContentBlock[] = [{ type: 'text', text }];

  for (const image of images) {
    const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(image.trim());
    if (match?.[1] && match[2]) {
      blocks.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
  }

  return blocks;
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
const saveMemoryArgsSchema = z.object({
  memory: z.string().trim().min(1).max(FAST_AGENT_MEMORY_FACT_MAX_CHARS),
});

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

export const FAST_AGENT_INFERENCE_MAX_RETRIES = INFERENCE_PROVIDER_MAX_RETRIES;
export const FAST_AGENT_TRANSIENT_INFERENCE_MAX_RETRIES = 6;
const FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const FAST_AGENT_QUIET_STATUS_INTERVAL_MS = 10 * 60_000;
const FAST_AGENT_ACTIVITY_PERSIST_INTERVAL_MS = 30_000;
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
  signal?: AbortSignal;
};

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
  switch (failure.reason) {
    case 'endpoint_unreachable':
    case 'gateway_blocked':
    case 'timeout':
      return FAST_AGENT_TRANSIENT_INFERENCE_MAX_RETRIES;
    default:
      return FAST_AGENT_INFERENCE_MAX_RETRIES;
  }
}

function resolveFastAgentInferenceRetryDelayMs(
  error: unknown,
  failure: FastAgentInferenceFailure,
  retryNumber: number,
): number {
  const delayMs = resolveInferenceProviderRetryDelayMs({
    error,
    attemptNumber: retryNumber,
    rateLimited: failure.reason === 'rate_limited',
  });

  if (
    resolveFastAgentInferenceMaxRetries(failure) ===
    FAST_AGENT_INFERENCE_MAX_RETRIES
  ) {
    return delayMs;
  }

  // Positive jitter spreads concurrent recovery attempts without shortening
  // the 61-second base backoff window. Six retries remain bounded below 75s.
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
  for (let retryNumber = 0; ; retryNumber += 1) {
    try {
      options.signal?.throwIfAborted();
      return await run();
    } catch (error) {
      // Session loss is the session manager's bootstrap signal, not a
      // provider failure this loop should absorb.
      if (isNonTaskOpenCodeSessionNotFoundError(error)) {
        throw error;
      }

      const failure = classifyNonTaskInferenceError(error);
      const maxRetries = resolveFastAgentInferenceMaxRetries(failure);
      if (
        !failure.retryable ||
        options.canRetry?.(error, failure) === false ||
        retryNumber >= maxRetries
      ) {
        throw new FastAgentInferenceError(failure, error);
      }

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
): string {
  return `<current_message>\n${escapeFastAgentEnvelopeJson({
    ...(sender?.displayName ? { sender_name: sender.displayName } : {}),
    ...(sender?.githubLogin ? { sender_github: sender.githubLogin } : {}),
    text,
  })}\n</current_message>`;
}

function escapeFastAgentEnvelopeJson(value: Record<string, string>): string {
  return JSON.stringify(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
  turnSource,
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
  turnSource: FastAgentTurnSource;
}): {
  bootstrapMessages: ModelMessage[];
  turnMessages: ModelMessage[];
  bootstrapThreadContextPresent: boolean;
  turnThreadContextPresent: boolean;
} {
  const normalizedQuestion = normalizeThreadText(question);
  const currentUserMessageText =
    surface === 'slack'
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
        ? wrapFastAgentMessage(normalizedQuestion, currentMessageSender)
        : normalizedQuestion;
  const turnMessage = buildUserTextMessage(currentUserMessageText);

  if (compatibilityMessages.length > 0) {
    const supplementalThreadContext = buildSupplementalThreadContext({
      threadContext,
      compatibilityMessages,
      currentMessageTs,
      surface,
    });
    const turnMessages = [
      ...(supplementalThreadContext
        ? [buildUserTextMessage(supplementalThreadContext)]
        : []),
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
    currentMessageTs && surface === 'slack'
      ? buildSlackThreadPromptBlocks({
          threadMessages: threadContext,
          currentMessageTs,
        })
      : {
          threadContext: wrapFastAgentThreadContext(threadContext),
          replyingTo: undefined,
        };
  const bootstrapText = [
    serializedThreadContext,
    replyingTo,
    currentUserMessageText,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');
  return {
    bootstrapMessages: [buildUserTextMessage(bootstrapText)],
    turnMessages: [turnMessage],
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
  platformEventHandling = 'default',
  platformEventVisibility = 'optional',
  platformEventKind = 'delegated_task',
  allowSilentAmbientReply = false,
  platformEventTranscriptPayload,
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
  platformEventHandling?: FastAgentPlatformEventHandling;
  platformEventVisibility?: FastAgentPlatformEventVisibility;
  platformEventKind?: FastAgentPlatformEventKind;
  /** True only for an unmentioned turn in a multi-human Fast conversation. */
  allowSilentAmbientReply?: boolean;
  platformEventTranscriptPayload?: Record<string, unknown>;
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
  const turnVisibleMessages: ModelMessage[] = [];
  let mirroredMessageCount = 0;
  let canonicalConversationId: string | null = null;
  let durableOpenCodeSessionId: string | null = null;
  let lastVisibleMessage = '';
  let closed = false;
  let visibleUpdatePosted = false;
  let inferenceRetryReply: FastAgentReplyHandle | undefined;
  let inferenceRetryMessageIndex: number | undefined;
  let inferenceRetryCanonicalEvent:
    | { eventId: string; turnSeq: number }
    | undefined;
  let inferenceRetryAttempted = false;
  let activeOpenCodeSessionId: string | null = null;
  let completedOpenCodeMessage: NonTaskOpenCodeCompletedMessage | null = null;
  let nextAssistantOrdinal = 0;
  let nextToolOrdinal = 0;
  let nextRetryNoticeOrdinal = 0;
  let nextLifecycleOrdinal = 0;
  let nextTurnSeq = 0;
  let lifecycleState = 'initializing';
  let lifecycleStateStartedAt = Date.now();
  let lastMeaningfulActivityAt = lifecycleStateStartedAt;
  let lastPersistedProviderActivityAt = 0;
  let activeLifecycleToolCount = 0;
  let activePersistenceCount = 0;
  let quietStatusTimer: ReturnType<typeof setTimeout> | undefined;
  let quietStatusEnabled = false;
  let reportQuietStatus: () => Promise<void> = async () => undefined;
  const lifecycleWrites = new Set<Promise<void>>();
  const degradedContextComponents = new Set<string>();

  const allocateCanonicalEvent = (slot: string) => ({
    eventId: `${turnId}:${slot}`,
    turnSeq: nextTurnSeq++,
  });
  const writeCanonicalMessage = async (
    message: Parameters<typeof upsertFastAgentMessage>[0]['message'],
    bestEffort = false,
  ): Promise<void> => {
    if (!canonicalConversationId) {
      if (bestEffort) return;
      throw new Error(
        'Fast conversation is not ready for message persistence.',
      );
    }

    try {
      await upsertFastAgentMessage({
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
  const clearQuietStatusTimer = () => {
    if (!quietStatusTimer) return;
    clearTimeout(quietStatusTimer);
    quietStatusTimer = undefined;
  };
  const scheduleQuietStatus = () => {
    clearQuietStatusTimer();
    if (!quietStatusEnabled || closed) return;
    quietStatusTimer = setTimeout(() => {
      quietStatusTimer = undefined;
      void reportQuietStatus();
    }, FAST_AGENT_QUIET_STATUS_INTERVAL_MS);
    quietStatusTimer.unref();
  };
  const persistLifecycleEvent = async (
    kind: string,
    details: Record<string, unknown> = {},
    options: { meaningful?: boolean; state?: string; atMs?: number } = {},
  ) => {
    const atMs = options.atMs ?? Date.now();
    const previousState = lifecycleState;
    if (options.state && options.state !== lifecycleState) {
      lifecycleState = options.state;
      lifecycleStateStartedAt = atMs;
    }
    if (options.meaningful !== false) {
      lastMeaningfulActivityAt = atMs;
      scheduleQuietStatus();
    }
    const event = allocateCanonicalEvent(`lifecycle:${nextLifecycleOrdinal++}`);
    await writeCanonicalMessage(
      {
        ...event,
        turnId,
        ts: atMs,
        eventType: 'roomote_runtime.fast_agent_lifecycle',
        contentBlocks: [],
        metadata: { visibleInTranscript: false, lifecycleKind: kind },
        payload: {
          kind,
          state: lifecycleState,
          previousState,
          stateStartedAtMs: lifecycleStateStartedAt,
          stateAgeMs: Math.max(0, atMs - lifecycleStateStartedAt),
          lastMeaningfulActivityAtMs: lastMeaningfulActivityAt,
          lastMeaningfulActivityAgeMs: Math.max(
            0,
            atMs - lastMeaningfulActivityAt,
          ),
          activeToolCount: activeLifecycleToolCount,
          persistenceActive: activePersistenceCount > 0,
          steeringAvailable: isFastAgentCommunicationConversation(conversation),
          steeringAccepted: turnSource === 'human',
          ...details,
        },
        source: conversation.surface,
        nativeSessionId: activeOpenCodeSessionId,
      },
      true,
    );
  };
  const queueLifecycleEvent = (
    kind: string,
    details: Record<string, unknown> = {},
    options: { meaningful?: boolean; state?: string; atMs?: number } = {},
  ) => {
    const write = persistLifecycleEvent(kind, details, options);
    lifecycleWrites.add(write);
    void write.finally(() => lifecycleWrites.delete(write));
  };
  const persistCanonicalMessage = async (
    message: Parameters<typeof upsertFastAgentMessage>[0]['message'],
    bestEffort = false,
  ) => {
    activePersistenceCount += 1;
    queueLifecycleEvent(
      'persistence_started',
      { persistedEventType: message.eventType },
      { meaningful: true },
    );
    try {
      await writeCanonicalMessage(message, bestEffort);
    } finally {
      activePersistenceCount = Math.max(0, activePersistenceCount - 1);
      queueLifecycleEvent(
        'persistence_finished',
        { persistedEventType: message.eventType },
        { meaningful: true },
      );
    }
  };
  const persistAssistantReply = async ({
    reply,
    event,
    platformMessageId,
    nativeMessage,
    inferenceRetryNotice = false,
    visibleInTranscript = true,
  }: {
    reply: FastAgentReply;
    event: { eventId: string; turnSeq: number };
    platformMessageId?: string;
    nativeMessage?: NonTaskOpenCodeCompletedMessage | null;
    inferenceRetryNotice?: boolean;
    visibleInTranscript?: boolean;
  }) =>
    persistCanonicalMessage(
      {
        ...event,
        turnId,
        // createdAtMs predates the turn's tool events and would sort the
        // reply above the tool activity that produced it, so fall straight
        // through to the persist-time clock when completion time is missing.
        ts: nativeMessage?.completedAtMs ?? Date.now(),
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
          ...(platformMessageId ? { platformMessageId } : {}),
        },
        payload: {
          purpose: reply.purpose,
          ...(platformEventTranscriptPayload ?? {}),
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
  reportQuietStatus = async () => {
    if (!quietStatusEnabled || closed) return;
    const atMs = Date.now();
    const quietMinutes = Math.max(
      1,
      Math.floor((atMs - lastMeaningfulActivityAt) / 60_000),
    );
    const detail =
      activeLifecycleToolCount > 0
        ? 'A tool is still running.'
        : activePersistenceCount > 0
          ? 'Roomote is saving the latest activity.'
          : lifecycleState === 'provider_retry'
            ? 'The inference provider is retrying the request.'
            : lifecycleState === 'provider_disconnected'
              ? 'The provider connection was interrupted; Roomote is still waiting for the turn to settle.'
              : lifecycleState === 'idle'
                ? 'OpenCode currently reports the session as idle while Roomote waits for the turn to settle.'
                : 'OpenCode still reports the model request as active.';
    const message = `This run is still open after ${quietMinutes} minutes without new lifecycle activity. ${detail} Use Follow in Roomote or reply with guidance.`;
    const reply = { purpose: 'progress' as const, message };
    try {
      const posted = await adapter.postReply(reply);
      diagnostics.recordVisibleReply({ assistantResponse: false });
      visibleUpdatePosted = true;
      await persistAssistantReply({
        reply,
        event: allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
        platformMessageId: posted?.messageId,
      });
      await persistLifecycleEvent(
        'quiet_status_reported',
        { quietMinutes },
        { meaningful: false, atMs },
      );
    } catch (error) {
      console.warn(
        `[Fast Agent] Failed to post quiet status: ${formatErrorForLog(error)}`,
      );
    } finally {
      scheduleQuietStatus();
    }
  };
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
    const canonicalEvent = allocateCanonicalEvent(`tool:${ordinal}`);
    await persistCanonicalMessage(
      {
        ...canonicalEvent,
        turnId,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        role: 'tool',
        contentBlocks: [],
        metadata: { visibleInTranscript: true },
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
        metadata: { visibleInTranscript: true, truncated },
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

  const replaceInferenceRetryReply = async (
    reply: FastAgentReply,
    bestEffort = false,
    onDelivered?: () => void,
  ): Promise<boolean> => {
    if (!inferenceRetryCanonicalEvent) {
      return false;
    }

    const retryEvent = inferenceRetryCanonicalEvent;
    const retryMessageIndex = inferenceRetryMessageIndex;
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
      });
    }
    return true;
  };

  try {
    turnVisibleMessages.push(
      buildUserTextMessage(normalizeThreadText(question)),
    );
    const [
      availableEnvironments,
      taskModelOptions,
      session,
      availableIntegrations,
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
        ? Promise.resolve({ displayName: null, githubLogin: null })
        : getFastAgentUserIdentity(userId).catch((error) => {
            degradedContextComponents.add('user_identity');
            console.warn(
              `[Fast Agent] User identity unavailable: ${formatErrorForLog(error)}`,
            );
            return { displayName: null, githubLogin: null };
          }),
    ]);
    canonicalConversationId = session.id;
    await reconcileFastAgentInferenceRetryNotices(session.id).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to reconcile interrupted inference retry notices: ${formatErrorForLog(error)}`,
      );
    });
    await setFastSessionResponding(session.id, true).catch((error) => {
      console.warn(
        `[sessions] Failed to mark Fast Session active: ${formatErrorForLog(error)}`,
      );
    });
    durableOpenCodeSessionId = session.openCodeSessionId;
    activeOpenCodeSessionId = session.openCodeSessionId;
    diagnostics.setCanonicalConversationId(session.id);
    const userEvent = allocateCanonicalEvent('user');
    await persistCanonicalMessage(
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
          // Platform-event prompts are internal <platform_event> JSON, not
          // something a person typed — keep them out of the transcript view.
          visibleInTranscript: !platformEvent,
          turnSource,
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
    await persistLifecycleEvent(
      'turn_started',
      {
        turnSource,
        platformEventKind,
        steeringAvailable: isFastAgentCommunicationConversation(conversation),
        steeringAccepted: turnSource === 'human',
      },
      { state: 'working' },
    );
    if (!platformEvent) {
      void refreshFastAgentSessionTitle({ sessionId: session.id, userId });
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
      turnSource,
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
      platformEventHandling,
      platformEventVisibility,
      platformEventKind,
      retryTaskStartAvailable: Boolean(adapter.retryTaskStart),
      allowSilentAmbientReply,
      releaseVersion,
    });
    const integrationCallSignatures = new Set<string>();
    const completedChatReactionSignatures = new Set<string>();
    const completedChatReplySignatures = new Set<string>();
    const completedTaskActions = new Set<string>();
    let nativeToolInvoked = false;
    let retriedTaskStart = false;
    let activeInferenceSignal: AbortSignal | undefined;
    let notifyToolExecutionStarted: () => void = () => undefined;
    let notifyToolExecutionFinished: () => void = () => undefined;

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
    ) => {
      const replacedRetry = await replaceInferenceRetryReply(reply, true, () =>
        diagnostics.recordVisibleReply(),
      );
      if (!replacedRetry) {
        const posted = await adapter.postReply(reply);
        diagnostics.recordVisibleReply();
        turnVisibleMessages.push(buildAssistantTextMessage(reply.message));
        await persistAssistantReply({
          reply,
          event: allocateCanonicalEvent(`assistant:${nextAssistantOrdinal++}`),
          platformMessageId: posted?.messageId,
          nativeMessage,
        });
      }
      inferenceRetryReply = undefined;
      inferenceRetryMessageIndex = undefined;
      inferenceRetryCanonicalEvent = undefined;
      lastVisibleMessage = reply.message;
      visibleUpdatePosted = true;
      if (reply.purpose === 'closeout' || reply.purpose === 'clarification') {
        closed = true;
      }
      if (mirrorImmediately) {
        await mirrorPendingMessages(true);
      }
    };

    const reportedInferenceNotices = new Set<string>();
    const reportInferenceRetry = async (
      notice: FastAgentInferenceRetryNotice,
    ) => {
      inferenceRetryAttempted = true;
      if (platformEvent) {
        return;
      }

      const message = formatFastAgentInferenceRetryNotice(notice);
      if (reportedInferenceNotices.has(message)) {
        return;
      }

      reportedInferenceNotices.add(message);
      // Deliberately not the postReply closure: a system retry notice must
      // not satisfy the model's acknowledgement gate or close the turn.
      const reply = { purpose: 'progress' as const, message };
      if (!(await replaceInferenceRetryReply(reply))) {
        inferenceRetryReply = (await adapter.postReply(reply)) || undefined;
        inferenceRetryMessageIndex = turnVisibleMessages.length;
        turnVisibleMessages.push(buildAssistantTextMessage(message));
        // Ordinal-suffixed so a second retry episode in the same turn gets
        // its own row instead of overwriting the first notice's upsert slot.
        inferenceRetryCanonicalEvent ??= allocateCanonicalEvent(
          `retry-notice:${nextRetryNoticeOrdinal++}`,
        );
        await persistAssistantReply({
          reply,
          event: inferenceRetryCanonicalEvent,
          platformMessageId: inferenceRetryReply?.messageId,
          inferenceRetryNotice: true,
        });
      }
      diagnostics.recordVisibleReply({ assistantResponse: false });
    };
    const reportProviderRetryEvent = async (
      event: NonTaskProviderRetryEvent,
    ) => {
      diagnostics.recordOpenCodeProviderRetry(event.attempt, event.message);
      await reportInferenceRetry({
        failure: classifyNonTaskInferenceError(new Error(event.message)),
        attemptNumber: event.attempt,
      });
    };
    const reportRoomoteInferenceRetry = async (
      notice: FastAgentInferenceRetryNotice,
    ) => {
      diagnostics.recordRoomoteInferenceRetry();
      await reportInferenceRetry(notice);
    };

    const requireOpen = () =>
      closed
        ? { success: false as const, error: 'This Fast turn is closed.' }
        : null;
    const throwIfTurnCancelled = () => {
      const reason = signal?.aborted
        ? signal.reason
        : activeInferenceSignal?.aborted
          ? activeInferenceSignal.reason
          : undefined;
      if (reason === undefined) return;
      throw reason instanceof Error
        ? reason
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
    const requireAcknowledgement = () =>
      !platformEvent && !visibleUpdatePosted
        ? {
            success: false as const,
            error:
              'Post an acknowledgement with send_chat_reply before this action.',
          }
        : null;

    const executeMcpTool = async (
      call: FastAgentMcpToolCall,
    ): Promise<unknown> => {
      notifyToolExecutionStarted();
      const toolStartedAt = Date.now();
      activeLifecycleToolCount += 1;
      queueLifecycleEvent(
        'tool_started',
        {
          toolKind: 'mcp',
          toolName: call.toolName,
          toolStartedAtMs: toolStartedAt,
        },
        { state: 'tool_running', atMs: toolStartedAt },
      );
      let canonicalToolEvent:
        | Awaited<ReturnType<typeof beginCanonicalToolEvent>>
        | undefined;
      try {
        const closedError = requireOpen();
        if (closedError) return closedError;
        const ownershipError = requireLockOwnership();
        if (ownershipError) return ownershipError;
        nativeToolInvoked = true;

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
        const actorScopedIntegrationArguments = chatLookupProvider
          ? { ...chatLookupArguments, provider: chatLookupProvider }
          : chatLookupArguments;
        const managesCustomAutomations =
          call.integrationId === ROOMOTE_MCP_ID &&
          call.toolName === MANAGE_CUSTOM_AUTOMATIONS_TOOL.name;
        if (!managesCustomAutomations) {
          const ackError = requireAcknowledgement();
          if (ackError) return ackError;
        }
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
        throwIfTurnCancelled();
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
        activeLifecycleToolCount = Math.max(0, activeLifecycleToolCount - 1);
        queueLifecycleEvent(
          'tool_finished',
          {
            toolKind: 'mcp',
            toolName: call.toolName,
            toolStartedAtMs: toolStartedAt,
            toolDurationMs: Math.max(0, Date.now() - toolStartedAt),
          },
          { state: 'working' },
        );
        notifyToolExecutionFinished();
      }
    };

    const executeNativeToolInner = async (
      call: FastAgentNativeToolCall,
    ): Promise<unknown> => {
      const recordToolFinished = diagnostics.recordNativeToolStarted(call.name);

      try {
        const closedError = requireOpen();
        if (closedError) return closedError;
        const ownershipError = requireLockOwnership();
        if (ownershipError) return ownershipError;
        nativeToolInvoked = true;

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
              args.message,
              args.imageArtifactIds ?? [],
            ]);
            if (completedChatReplySignatures.has(signature)) {
              return {
                success: true,
                delivered: true,
                duplicate: true,
                closed,
              };
            }
            throwIfTurnCancelled();
            await postReply({
              purpose: args.purpose,
              message: args.message,
              ...(args.imageArtifactIds?.length
                ? { imageArtifactIds: args.imageArtifactIds }
                : {}),
              ...(args.suggestions?.length
                ? { suggestions: args.suggestions }
                : {}),
            });
            completedChatReplySignatures.add(signature);
            return { success: true, delivered: true, closed };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction: {
            const args = chatReactionArgsSchema.parse(call.args);
            if (!adapter.postReaction) {
              return {
                success: false,
                error: 'Emoji reactions are unavailable on this surface.',
              };
            }
            const name = args.name.replace(/^:+|:+$/g, '');
            if (!name || /\s/.test(name)) {
              return { success: false, error: 'Invalid reaction name.' };
            }
            const messageId = currentMessageId ?? conversation.conversationId;
            const signature = JSON.stringify([name, args.purpose, messageId]);
            if (completedChatReactionSignatures.has(signature)) {
              return {
                success: true,
                delivered: true,
                duplicate: true,
                closed,
              };
            }
            throwIfTurnCancelled();
            await adapter.postReaction({
              name,
              purpose: args.purpose,
              messageId,
            });
            completedChatReactionSignatures.add(signature);
            turnVisibleMessages.push(
              buildAssistantTextMessage(`[Reacted with :${name}:]`),
            );
            await persistCanonicalMessage(
              {
                ...allocateCanonicalEvent(
                  `assistant:${nextAssistantOrdinal++}`,
                ),
                turnId,
                ts: Date.now(),
                eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
                role: 'assistant',
                contentBlocks: [
                  { type: 'text', text: `[Reacted with :${name}:]` },
                ],
                metadata: { visibleInTranscript: true },
                payload: { reaction: name, purpose: args.purpose },
                source: conversation.surface,
                nativeSessionId: activeOpenCodeSessionId,
              },
              true,
            );
            visibleUpdatePosted = true;
            if (args.purpose === 'closeout') closed = true;
            return { success: true, delivered: true, closed };
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
                  message: result.textFallback,
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
                ? `${Env.R_APP_URL}/sessions/${linkedSession.id}?task=${task.taskId}`
                : task.taskUrl;
              const message = [
                `Preparing workspace…\n\n${args.kickoffMessage}`,
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
            const result = await adapter.launchTask({
              prompt,
              ...(args.includeAttachments && images.length > 0
                ? { images }
                : {}),
              environmentId: args.environmentId ?? null,
              model: args.model ?? null,
              parentSessionId: session.id,
              postKickoff: deliverKickoff,
            });
            if (result.success) {
              currentTasks.set(result.taskId, { taskId: result.taskId });
              if (result.kickoffDelivered) {
                visibleUpdatePosted = true;
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
            const ackError = requireAcknowledgement();
            if (ackError) return ackError;
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

          case FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent: {
            ignoreEventArgsSchema.parse(call.args);
            if (!platformEvent && !allowSilentAmbientReply) {
              return {
                success: false,
                error:
                  'Only an optional platform event or eligible ambient human message may be ignored.',
              };
            }
            if (platformEvent && platformEventVisibility === 'required') {
              return {
                success: false,
                error: 'This platform event requires a user-visible closeout.',
              };
            }
            closed = true;
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
      notifyToolExecutionStarted();
      const toolStartedAt = Date.now();
      activeLifecycleToolCount += 1;
      queueLifecycleEvent(
        'tool_started',
        {
          toolKind: 'native',
          toolName: call.name,
          toolStartedAtMs: toolStartedAt,
        },
        { state: 'tool_running', atMs: toolStartedAt },
      );
      let canonicalToolEvent:
        | Awaited<ReturnType<typeof beginCanonicalToolEvent>>
        | undefined;
      try {
        const ownershipError = requireLockOwnership();
        if (ownershipError) return ownershipError;
        canonicalToolEvent = await beginCanonicalToolEvent({
          title: call.name,
          args: call.args,
          nativeSessionId: call.sessionId,
          kind: getFastAgentNativeAcpKind(call.name),
        });
        const result = await executeNativeToolInner(call);
        await finishCanonicalToolEvent(
          canonicalToolEvent,
          result,
          call.sessionId,
        );
        return result;
      } catch (error) {
        if (canonicalToolEvent) {
          await finishCanonicalToolEvent(
            canonicalToolEvent,
            toolFailure(error),
            call.sessionId,
          );
        }
        throw error;
      } finally {
        activeLifecycleToolCount = Math.max(0, activeLifecycleToolCount - 1);
        queueLifecycleEvent(
          'tool_finished',
          {
            toolKind: 'native',
            toolName: call.name,
            toolStartedAtMs: toolStartedAt,
            toolDurationMs: Math.max(0, Date.now() - toolStartedAt),
          },
          { state: 'working' },
        );
        notifyToolExecutionFinished();
      }
    };

    const imageFiles = getFastAgentImageFiles(images);
    const serializedTurnPrompt = serializeFastAgentMessages(turnMessages);
    const serializedBootstrapPrompt =
      serializeFastAgentMessages(bootstrapMessages);
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
      bootstrapPrompt: serializedBootstrapPrompt,
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
        );
        const nativeRuntime = await getFastAgentNativeToolRuntime(
          session.id,
          availableIntegrations,
        );
        const unbindExecutors = new Set<() => void>();
        const boundSubagentSessionIDs = new Set<string>();
        const unbindAllExecutors = () => {
          for (const unbind of unbindExecutors) unbind();
          unbindExecutors.clear();
          boundSubagentSessionIDs.clear();
        };
        let promptForAttempt = selectedPrompt;
        let imageFilesForAttempt = imageFiles;
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
          const result = await runFastAgentInferenceWithRetries(
            async () => {
              const providerRetryAbortController = new AbortController();
              const promptSignal = signal
                ? AbortSignal.any([signal, providerRetryAbortController.signal])
                : providerRetryAbortController.signal;
              activeInferenceSignal = promptSignal;
              let providerRetryTimeout:
                | ReturnType<typeof setTimeout>
                | undefined;
              let providerRetryDeadlineAt: number | undefined;
              let activeToolExecutionCount = 0;
              const clearProviderRetryTimeout = () => {
                if (!providerRetryTimeout) return;
                clearTimeout(providerRetryTimeout);
                providerRetryTimeout = undefined;
              };
              const armProviderRetryTimeout = () => {
                if (
                  providerRetryDeadlineAt === undefined ||
                  activeToolExecutionCount > 0
                ) {
                  return;
                }
                clearProviderRetryTimeout();
                const remainingMs = Math.max(
                  0,
                  providerRetryDeadlineAt - Date.now(),
                );
                providerRetryTimeout = setTimeout(() => {
                  providerRetryAbortController.abort(
                    new NonTaskOpenCodePromptTimeoutError(
                      FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS,
                    ),
                  );
                }, remainingMs);
                providerRetryTimeout.unref();
              };
              notifyToolExecutionStarted = () => {
                activeToolExecutionCount += 1;
                clearProviderRetryTimeout();
              };
              notifyToolExecutionFinished = () => {
                activeToolExecutionCount = Math.max(
                  0,
                  activeToolExecutionCount - 1,
                );
                if (activeToolExecutionCount > 0) return;
                if (providerRetryDeadlineAt !== undefined) {
                  armProviderRetryTimeout();
                }
              };
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
                          providerRetryDeadlineAt === undefined
                        ) {
                          providerRetryDeadlineAt =
                            Date.now() +
                            FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS;
                          armProviderRetryTimeout();
                        }
                        await reportProviderRetryEvent(event);
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
                      tools: buildFastAgentToolFilter(
                        availableIntegrations.map(
                          (integration) => integration.id,
                        ),
                      ),
                      onModelResolved: (model) => {
                        resolvedInferenceModel = model;
                        diagnostics.recordModelResolved(model);
                      },
                      onMessageCompleted: (message) => {
                        completedOpenCodeMessage = message;
                      },
                      onPromptStarted: () => {
                        promptStarted = true;
                        diagnostics.markInferenceStarted();
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
                      onLifecycleEvent: (event) => {
                        const requestId = `${turnId}:attempt:${inferenceAttemptNumber}`;
                        if (event.type === 'provider_activity') {
                          lastMeaningfulActivityAt = event.atMs;
                          scheduleQuietStatus();
                          if (
                            event.atMs - lastPersistedProviderActivityAt <
                            FAST_AGENT_ACTIVITY_PERSIST_INTERVAL_MS
                          ) {
                            return;
                          }
                          lastPersistedProviderActivityAt = event.atMs;
                        }
                        const state =
                          event.type === 'session_status'
                            ? event.status
                            : event.type === 'provider_retry'
                              ? 'provider_retry'
                              : event.type;
                        if (event.type === 'provider_request_started') {
                          quietStatusEnabled = true;
                        } else if (event.type === 'provider_request_ended') {
                          quietStatusEnabled = false;
                          clearQuietStatusTimer();
                        }
                        queueLifecycleEvent(
                          event.type,
                          {
                            requestId,
                            attemptNumber: inferenceAttemptNumber,
                            ...event,
                          },
                          { state, atMs: event.atMs },
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
                            () =>
                              Promise.resolve({
                                success: false,
                                error:
                                  'That tool is reserved for the Fast parent agent.',
                              }),
                            {
                              allowSkillAccess: false,
                              allowSpillRecovery: false,
                              skillStore,
                              spillBudget,
                            },
                          ),
                        );
                      },
                    },
                  );
                const result = await resultPromise;
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
                notifyToolExecutionStarted = () => undefined;
                notifyToolExecutionFinished = () => undefined;
                if (activeInferenceSignal === promptSignal) {
                  activeInferenceSignal = undefined;
                }
                clearProviderRetryTimeout();
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
                !closed &&
                (!nativeToolInvoked || openCodeSession.id !== undefined) &&
                !isNonTaskOpenCodePromptTimeoutError(error) &&
                !isNonTaskOpenCodeSessionValidationError(error),
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
                  promptForAttempt = serializedBootstrapPrompt;
                  imageFilesForAttempt = imageFiles;
                  promptKind = 'clean_retry_bootstrap';
                  attemptSessionPath = 'cold_rebuild';
                  diagnostics.recordSessionPath(attemptSessionPath);
                }
                // Keep every recovery attempt bounded so it cannot hold the
                // conversation lock forever if the provider stalls again.
                promptTimeoutMs = FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS;
              },
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
    if (!closed) {
      const message = promptText.trim();
      if (message) {
        await postReply(
          { purpose: 'closeout', message },
          false,
          completedOpenCodeMessage,
        );
      } else if (!visibleUpdatePosted) {
        // A delivered update is already a complete visible response. Stay
        // silent rather than append a generic closeout that contradicts it.
        await postReply({
          purpose: 'closeout',
          message:
            'I could not complete that request within the available turn.',
        });
      }
    }
    await mirrorPendingMessages();
    await persistLifecycleEvent(
      'turn_completed',
      {},
      { meaningful: false, state: 'completed' },
    );
    return lastVisibleMessage;
  } catch (error) {
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
    await persistLifecycleEvent(
      signal?.aborted ? 'turn_aborted' : 'turn_failed',
      {
        abortReason: signal?.aborted
          ? signal.reason instanceof Error
            ? signal.reason.name
            : 'external_abort'
          : error instanceof FastAgentInferenceError
            ? error.failure.reason
            : 'unclassified',
      },
      {
        meaningful: false,
        state: signal?.aborted ? 'aborted' : 'failed',
      },
    );
    if (signal?.aborted) {
      if (canonicalConversationId) {
        fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
      }
      if (inferenceRetryReply) {
        await replaceInferenceRetryReply(
          {
            purpose: 'closeout',
            message: INTERRUPTED_INFERENCE_RETRY_MESSAGE,
          },
          true,
        );
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
    if (!closed) {
      try {
        const reply = { purpose: 'closeout' as const, message };
        if (
          !(await replaceInferenceRetryReply(reply, true, () =>
            diagnostics.recordVisibleReply(),
          ))
        ) {
          const posted = await adapter.postReply(reply);
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
    return lastVisibleMessage || message;
  } finally {
    quietStatusEnabled = false;
    clearQuietStatusTimer();
    if (canonicalConversationId) {
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
        ).catch((error) => {
          console.warn(
            `[Fast Agent] Failed to reconcile settled inference retry notices: ${formatErrorForLog(error)}`,
          );
        });
      }
    }
    while (lifecycleWrites.size > 0) {
      await Promise.allSettled([...lifecycleWrites]);
    }
    diagnostics.finish();
  }
}

export { FAST_AGENT_MODEL_ROLE };
export type { RoutableEnvironment };

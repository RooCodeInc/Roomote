import type { ModelMessage } from 'ai';
import {
  ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME,
  ROOMOTE_OPENCODE_JUDGE_AGENT_NAME,
} from '../../opencode-prompt-subagents';
import {
  BRAIN_MCP_ID,
  INFERENCE_PROVIDER_MAX_RETRIES,
  formatErrorForLog,
  resolveInferenceProviderRetryDelayMs,
  roomoteTaskInspectionArgsSchema,
} from '@roomote/types';
import { getDeploymentTaskModelOptions } from '@roomote/db/server';
import { Env } from '@roomote/env';
import { z } from 'zod';

import packageJson from '../../../../../package.json';

import {
  buildSlackThreadPromptBlocks,
  wrapSlackMessage,
  wrapSlackThreadContext,
  type SlackThreadPromptMessage,
} from '../../utils';
import { resolveRoomoteReleaseVersion } from '../../release-version';
import { getAvailableEnvironments, type RoutableEnvironment } from '../router';
import { FAST_AGENT_MODEL_ROLE } from './fast-agent-constants';
import { buildFastAgentSystemPrompt } from './fast-agent-prompt';
import {
  appendFastAgentVisibleMessages,
  getActiveFastAgentTasks,
  getOrCreateFastAgentSession,
  type FastAgentActiveTask,
} from './fast-agent-session';
import {
  classifyNonTaskInferenceError,
  FAST_AGENT_SESSION_PERMISSIONS,
  generateTrackedNonTaskTextInOpenCodeSession,
  isNonTaskOpenCodePromptTimeoutError,
  isNonTaskOpenCodeSessionNotFoundError,
  NonTaskOpenCodePromptTimeoutError,
  NON_TASK_INFERENCE_SURFACES,
  type NonTaskPromptFile,
  type NonTaskProviderRetryEvent,
} from '../non-task-provider-usage';
import { fastAgentOpenCodeSessionManager } from './fast-agent-opencode-session';
import {
  bindFastAgentNativeToolExecutor,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeToolRuntime,
  type FastAgentNativeToolCall,
} from './fast-agent-native-tool-bridge';
import { isFastAgentSubagentTool } from './fast-agent-tool-policy';
import {
  callFastAgentIntegration,
  listFastAgentIntegrations,
} from './fast-agent-integration-broker';
import {
  cancelFastAgentTask,
  inspectFastAgentTasks,
  sendFastAgentTaskMessage,
} from './fast-agent-tasks';
import {
  fastAgentCustomAutomationArgsSchema,
  manageFastAgentCustomAutomations,
} from './fast-agent-custom-automations';
import { getFastAgentUserIdentity } from './fast-agent-user-identity';
import { FastAgentTurnDiagnostics } from './fast-agent-turn-diagnostics';
import {
  type FastAgentConversation,
  type FastAgentPlatformEventHandling,
  type FastAgentPlatformEventVisibility,
  type FastAgentReply,
  type FastAgentReplyHandle,
  type FastAgentTurnAdapter,
  type FastAgentTurnSource,
} from './fast-agent-conversation';

export type FastAgentThreadMessage = SlackThreadPromptMessage;

const chatReplyArgsSchema = z.object({
  message: z.string().trim().min(1),
  purpose: z.enum(['ack', 'progress', 'closeout', 'clarification']),
  imageArtifactIds: z.array(z.string()).optional(),
});
const chatReactionArgsSchema = z.object({
  name: z.string().trim().min(1),
  purpose: z.enum(['ack', 'closeout']),
});
const chatMessageContextArgsSchema = z.object({
  messageId: z.string().trim().min(1),
});
const chatChannelMessagesArgsSchema = z.object({
  oldest: z.string().trim().min(1).optional(),
  latest: z.string().trim().min(1).optional(),
});
const FAST_AGENT_DEFAULT_SLACK_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
  kickoffMessage: z.string().trim().min(1),
});
const taskMessageArgsSchema = z.object({
  taskId: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1),
});
const taskIdArgsSchema = z.object({
  taskId: z.string().trim().min(1).nullable().optional(),
});
const integrationCallArgsSchema = z.object({
  integrationId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  arguments: z.record(z.unknown()),
});
const ignoreEventArgsSchema = z.object({ reason: z.string().trim().min(1) });

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
const FAST_AGENT_TRANSIENT_RETRY_JITTER_RATIO = 0.2;

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
): string {
  switch (failure.reason) {
    case 'content_filter':
      return 'The inference provider blocked this response with its content filter, so retrying will not help. Try rephrasing the request or asking in a new thread.';
    case 'rate_limited':
      return 'The inference provider is still rate limiting requests after retrying. Any delegated tasks can keep running; please try again when provider capacity is available.';
    case 'timeout':
      return 'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.';
    case 'endpoint_unreachable':
      return 'Could not reach the inference provider after retrying. Please try again in a moment.';
    case 'gateway_blocked':
      return 'The request is still being blocked by the inference provider gateway after retrying. Please try again in a moment.';
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
      console.warn(
        `[Fast Agent] Retrying inference failure attempt=${attemptNumber}/${maxRetries} delayMs=${delayMs} reason=${failure.reason}: ${formatErrorForLog(error)}`,
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
  question,
  threadContext,
  compatibilityMessages,
}: {
  question: string;
  threadContext: FastAgentThreadMessage[];
  compatibilityMessages: ModelMessage[];
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

  const normalizedQuestion = normalizeThreadText(question);
  return wrapSlackThreadContext(
    threadContext
      .filter((message) => {
        const normalizedText = normalizeThreadText(message.text);
        if (!normalizedText || normalizedText === normalizedQuestion) {
          return false;
        }
        const key = `${message.bot_id ? 'assistant' : 'user'}:${normalizedText}`;
        const remaining = persistedMessageCounts.get(key) ?? 0;
        if (remaining > 0) {
          persistedMessageCounts.set(key, remaining - 1);
          return false;
        }
        return true;
      })
      .map((message) => ({
        displayName: message.username?.trim() || message.user,
        text: message.text,
        ts: message.ts,
      })),
  );
}

function buildFastAgentMessages({
  question,
  currentMessageAgentContext,
  threadContext,
  compatibilityMessages,
  currentMessageTs,
  currentMessageSender,
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
}): { bootstrapMessages: ModelMessage[]; turnMessage: ModelMessage } {
  const normalizedQuestion = normalizeThreadText(question);
  const currentUserMessageText = currentMessageTs
    ? wrapSlackMessage(normalizedQuestion, {
        ts: currentMessageTs,
        senderSlackId: currentMessageSender?.slackUserId,
        senderName: currentMessageSender?.displayName,
        senderGithub: currentMessageSender?.githubLogin,
        agentContext: currentMessageAgentContext,
      })
    : normalizedQuestion;
  const turnMessage = buildUserTextMessage(currentUserMessageText);

  if (compatibilityMessages.length > 0) {
    const supplementalThreadContext = buildSupplementalThreadContext({
      question,
      threadContext,
      compatibilityMessages,
    });
    return {
      bootstrapMessages: [
        ...compatibilityMessages,
        ...(supplementalThreadContext
          ? [buildUserTextMessage(supplementalThreadContext)]
          : []),
        turnMessage,
      ],
      turnMessage,
    };
  }

  const { threadContext: serializedThreadContext, replyingTo } =
    currentMessageTs
      ? buildSlackThreadPromptBlocks({
          threadMessages: threadContext,
          currentMessageTs,
        })
      : {
          threadContext: wrapSlackThreadContext(
            threadContext.map((message) => ({
              displayName: message.username?.trim() || message.user,
              text: message.text,
              ts: message.ts,
            })),
          ),
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
    turnMessage,
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
    return { error: 'There is no active delegated task.' };
  }
  const taskId =
    requestedTaskId ??
    (activeTasks.size === 1 ? activeTasks.keys().next().value : undefined);
  if (!taskId) {
    return {
      error:
        'Multiple delegated tasks are active. Ask the user which task they mean.',
    };
  }
  if (!activeTasks.has(taskId)) {
    return { error: `Task ${taskId} is not active in this conversation.` };
  }
  return { taskId };
}

function toolFailure(error: unknown): { success: false; error: string } {
  return { success: false, error: formatErrorForLog(error) };
}

export async function answerFastAgentQuestion({
  question,
  images = [],
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
  turnSource = 'human',
  platformEventHandling = 'default',
  platformEventVisibility = 'optional',
}: {
  question: string;
  images?: string[];
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
  turnSource?: FastAgentTurnSource;
  platformEventHandling?: FastAgentPlatformEventHandling;
  platformEventVisibility?: FastAgentPlatformEventVisibility;
}): Promise<string> {
  const diagnostics = new FastAgentTurnDiagnostics({
    conversation,
    currentMessageId,
    hasImages: images.length > 0,
    modelRole: FAST_AGENT_MODEL_ROLE,
    turnSource,
  });
  const platformEvent = turnSource === 'platform_event';
  const turnVisibleMessages: ModelMessage[] = [];
  let mirroredMessageCount = 0;
  let canonicalConversationId: string | null = null;
  let lastVisibleMessage = '';
  let inferenceRetryReply: FastAgentReplyHandle | undefined;
  let inferenceRetryMessageIndex: number | undefined;

  const replaceInferenceRetryReply = async (
    reply: FastAgentReply,
    bestEffort = false,
  ): Promise<boolean> => {
    if (!inferenceRetryReply || !adapter.replaceReply) {
      return false;
    }

    let replacement: FastAgentReplyHandle | void;
    try {
      replacement = await adapter.replaceReply(inferenceRetryReply, reply);
    } catch (error) {
      if (!bestEffort) {
        throw error;
      }
      console.warn(
        `[Fast Agent] Failed to replace inference retry notice: ${formatErrorForLog(error)}`,
      );
      inferenceRetryReply = undefined;
      inferenceRetryMessageIndex = undefined;
      return false;
    }
    inferenceRetryReply = replacement || inferenceRetryReply;
    if (inferenceRetryMessageIndex !== undefined) {
      turnVisibleMessages[inferenceRetryMessageIndex] =
        buildAssistantTextMessage(reply.message);
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
        console.warn(
          `[Fast Agent] Task model options unavailable: ${formatErrorForLog(error)}`,
        );
        return { models: [], defaultModelId: undefined };
      }),
      getOrCreateFastAgentSession({ userId, conversation }),
      listFastAgentIntegrations({ userId, apiBaseUrl }).catch((error) => {
        console.warn(
          `[Fast Agent] Deployment integrations unavailable: ${formatErrorForLog(error)}`,
        );
        return [];
      }),
      getFastAgentUserIdentity(userId).catch((error) => {
        console.warn(
          `[Fast Agent] User identity unavailable: ${formatErrorForLog(error)}`,
        );
        return { displayName: null, githubLogin: null };
      }),
    ]);
    canonicalConversationId = session.id;
    diagnostics.setCanonicalConversationId(session.id);
    const sessionActiveTasks = await getActiveFastAgentTasks(session.id);
    const resolvedActiveTasks = [
      ...new Map(
        [...activeTasks, ...sessionActiveTasks].map((task) => [
          task.taskId,
          task,
        ]),
      ).values(),
    ];
    const currentActiveTasks = new Map(
      resolvedActiveTasks.map((task) => [task.taskId, task]),
    );
    const { bootstrapMessages, turnMessage } = buildFastAgentMessages({
      question,
      currentMessageAgentContext,
      threadContext,
      compatibilityMessages: session.compatibilityMessages,
      currentMessageTs: currentMessageId,
      currentMessageSender: {
        slackUserId: senderExternalId,
        displayName:
          senderDisplayName?.trim() || currentUser.displayName || undefined,
        githubLogin: currentUser.githubLogin || undefined,
      },
    });
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
      retryTaskStartAvailable: Boolean(adapter.retryTaskStart),
      releaseVersion: resolveRoomoteReleaseVersion(
        Env.RELEASE_PRODUCT_VERSION,
        Env.RELEASE_VERSION,
        packageJson.version,
      ),
    });
    const integrationCallSignatures = new Set<string>();
    const completedTaskActions = new Set<string>();
    let visibleUpdatePosted = false;
    let kickoffPosted = false;
    let closed = false;
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
    ) => {
      const replacedRetry = await replaceInferenceRetryReply(reply, true);
      if (!replacedRetry) {
        await adapter.postReply(reply);
        turnVisibleMessages.push(buildAssistantTextMessage(reply.message));
      }
      inferenceRetryReply = undefined;
      inferenceRetryMessageIndex = undefined;
      diagnostics.recordVisibleReply();
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
      }
      diagnostics.recordVisibleReply();
    };
    const reportProviderRetryEvent = async (
      event: NonTaskProviderRetryEvent,
    ) => {
      diagnostics.recordOpenCodeProviderRetry(event.attempt);
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
    const requireAcknowledgement = () =>
      !platformEvent && !visibleUpdatePosted
        ? {
            success: false as const,
            error:
              'Post an acknowledgement with send_chat_reply before this action.',
          }
        : null;

    const executeNativeTool = async (
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
            throwIfTurnCancelled();
            await postReply({
              purpose: args.purpose,
              message: args.message,
              ...(args.imageArtifactIds?.length
                ? { imageArtifactIds: args.imageArtifactIds }
                : {}),
            });
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
            throwIfTurnCancelled();
            await adapter.postReaction({
              name,
              purpose: args.purpose,
              messageId: currentMessageId ?? conversation.conversationId,
            });
            turnVisibleMessages.push(
              buildAssistantTextMessage(`[Reacted with :${name}:]`),
            );
            visibleUpdatePosted = true;
            if (args.purpose === 'closeout') closed = true;
            return { success: true, delivered: true, closed };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.getChatMessageContext: {
            const args = chatMessageContextArgsSchema.parse(call.args);
            if (!adapter.getChatMessageContext) {
              return {
                success: false,
                error: 'Chat message context is unavailable for this turn.',
              };
            }
            throwIfTurnCancelled();
            return await adapter.getChatMessageContext(args);
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.getChatChannelMessages: {
            const args = chatChannelMessagesArgsSchema.parse(call.args);
            if (!adapter.getChatChannelMessages) {
              return {
                success: false,
                error: 'Chat channel history is unavailable for this turn.',
              };
            }
            throwIfTurnCancelled();
            return await adapter.getChatChannelMessages({
              ...args,
              ...(conversation.surface === 'slack' && !args.oldest
                ? {
                    oldest: getFastAgentDefaultSlackHistoryOldest(args.latest),
                  }
                : {}),
            });
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall: {
            const args = integrationCallArgsSchema.parse(call.args);
            if (args.integrationId !== BRAIN_MCP_ID) {
              const ackError = requireAcknowledgement();
              if (ackError) return ackError;
            }
            const signature = buildIntegrationCallSignature({
              integrationId: args.integrationId,
              toolName: args.toolName,
              args: args.arguments,
            });
            if (integrationCallSignatures.has(signature)) {
              return {
                success: false,
                error: 'The same integration call already ran in this turn.',
              };
            }
            integrationCallSignatures.add(signature);
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
                integrationId: args.integrationId,
                toolName: args.toolName,
                args: args.arguments,
              },
            );
            return { success: true, result };
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.launchTask: {
            const args = launchTaskArgsSchema.parse(call.args);
            const validEnvironmentIds = new Set(
              availableEnvironments.map((environment) => environment.id),
            );
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
              const message = [
                args.kickoffMessage,
                task.taskUrl &&
                !task.taskLinkRendered &&
                !args.kickoffMessage.includes(task.taskUrl)
                  ? `[Open the task](${task.taskUrl})`
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
              kickoffPosted = true;
            };
            throwIfTurnCancelled();
            const result = await adapter.launchTask({
              prompt: args.prompt,
              environmentId: args.environmentId ?? null,
              model: args.model ?? null,
              parentSessionId: session.id,
              postKickoff: deliverKickoff,
            });
            if (result.success) {
              currentActiveTasks.set(result.taskId, { taskId: result.taskId });
              if (result.kickoffDelivered) {
                visibleUpdatePosted = true;
                kickoffPosted = true;
              }
              if (!kickoffDelivered && !result.kickoffDelivered) {
                await deliverKickoff(result);
              }
            }
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks: {
            const args = roomoteTaskInspectionArgsSchema.parse(call.args);
            const result = await inspectFastAgentTasks(
              { userId, apiBaseUrl },
              args,
            );
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.manageCustomAutomations: {
            const args = fastAgentCustomAutomationArgsSchema.parse(call.args);
            if (
              args.action === 'create' ||
              args.action === 'update' ||
              args.action === 'delete' ||
              args.action === 'run_now'
            ) {
              const ackError = requireAcknowledgement();
              if (ackError) return ackError;
            }
            throwIfTurnCancelled();
            return await manageFastAgentCustomAutomations(
              { userId, apiBaseUrl },
              args,
            );
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage: {
            const args = taskMessageArgsSchema.parse(call.args);
            const ackError = requireAcknowledgement();
            if (ackError) return ackError;
            const target = selectActiveTaskId(args.taskId, currentActiveTasks);
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
            const result = await sendFastAgentTaskMessage(
              { userId, apiBaseUrl },
              { taskId: target.taskId, message: args.message },
            );
            return result;
          }

          case FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask: {
            const args = taskIdArgsSchema.parse(call.args);
            const ackError = requireAcknowledgement();
            if (ackError) return ackError;
            const target = selectActiveTaskId(args.taskId, currentActiveTasks);
            if (!target.taskId) return { success: false, error: target.error };
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
            if (result.success) currentActiveTasks.delete(target.taskId);
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

          case FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent: {
            ignoreEventArgsSchema.parse(call.args);
            if (!platformEvent) {
              return {
                success: false,
                error: 'Only a platform event can be ignored.',
              };
            }
            if (platformEventVisibility === 'required') {
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

    const nativeRuntime = await getFastAgentNativeToolRuntime();
    const imageFiles = getFastAgentImageFiles(images);
    const serializedTurnPrompt = serializeFastAgentMessages([turnMessage]);
    const serializedBootstrapPrompt =
      serializeFastAgentMessages(bootstrapMessages);
    diagnostics.markInferenceQueued();
    const promptTextPromise = fastAgentOpenCodeSessionManager.run({
      conversationId: session.id,
      prompt: serializedTurnPrompt,
      bootstrapPrompt: serializedBootstrapPrompt,
      execute: async (openCodeSession, selectedPrompt) => {
        diagnostics.markInferenceSetupStarted();
        const unbindExecutors = new Set<() => void>();
        const boundSubagentSessionIDs = new Set<string>();
        const unbindAllExecutors = () => {
          for (const unbind of unbindExecutors) unbind();
          unbindExecutors.clear();
          boundSubagentSessionIDs.clear();
        };
        let promptForAttempt = selectedPrompt;
        let promptTimeoutMs: number | null = null;
        try {
          return await runFastAgentInferenceWithRetries(
            async () => {
              const providerRetryAbortController = new AbortController();
              const promptSignal = signal
                ? AbortSignal.any([signal, providerRetryAbortController.signal])
                : providerRetryAbortController.signal;
              let providerRetryTimeout:
                | ReturnType<typeof setTimeout>
                | undefined;
              try {
                return await generateTrackedNonTaskTextInOpenCodeSession(
                  {
                    userId,
                    surface:
                      NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
                    modelRole: FAST_AGENT_MODEL_ROLE,
                    timeoutMs: promptTimeoutMs,
                    maxProviderRetryAttempts: FAST_AGENT_INFERENCE_MAX_RETRIES,
                    system,
                    prompt: promptForAttempt,
                    onProviderRetry: async (event) => {
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
                    },
                    ...(imageFiles.length
                      ? {
                          files: imageFiles,
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
                    tools: FAST_AGENT_NATIVE_TOOL_FILTER,
                    onModelResolved: (model) => {
                      diagnostics.recordModelResolved(model);
                    },
                    onPromptStarted: () => {
                      diagnostics.markInferenceStarted();
                    },
                    onSessionReady: (openCodeSessionID) => {
                      unbindAllExecutors();
                      unbindExecutors.add(
                        bindFastAgentNativeToolExecutor(
                          openCodeSessionID,
                          executeNativeTool,
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
                          (call) =>
                            (call.agent ===
                              ROOMOTE_OPENCODE_ADVISOR_AGENT_NAME ||
                              call.agent ===
                                ROOMOTE_OPENCODE_JUDGE_AGENT_NAME) &&
                            isFastAgentSubagentTool(call.name)
                              ? executeNativeTool(call)
                              : Promise.resolve({
                                  success: false,
                                  error:
                                    'That tool is reserved for the Fast parent agent.',
                                }),
                        ),
                      );
                    },
                  },
                );
              } finally {
                if (providerRetryTimeout) {
                  clearTimeout(providerRetryTimeout);
                }
              }
            },
            reportRoomoteInferenceRetry,
            {
              // OpenCode already owns retries while a provider turn remains
              // active. Roomote retries only a terminal failure that happened
              // before the model invoked any native tool, so replay cannot
              // duplicate a visible reply or external side effect. The signal
              // aborts only after definitive conversation-lock loss; retrying
              // then would post into a conversation another worker may own.
              canRetry: (error) =>
                !signal?.aborted &&
                !nativeToolInvoked &&
                !isNonTaskOpenCodePromptTimeoutError(error),
              prepareRetry: () => {
                // OpenCode persists the user message before inference starts,
                // and abort does not roll it back. Discard the failed session
                // and rebuild from visible compatibility history instead of
                // appending the same turn to a poisoned transcript.
                openCodeSession.id = undefined;
                promptForAttempt = serializedBootstrapPrompt;
                // Preserve unbounded initial turns, which may run native tools,
                // but do not let a clean-session recovery hold the conversation
                // lock forever if the replacement provider request stalls.
                promptTimeoutMs = FAST_AGENT_INFERENCE_RETRY_ATTEMPT_TIMEOUT_MS;
              },
              signal,
            },
          );
        } finally {
          unbindAllExecutors();
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
        await postReply({ purpose: 'closeout', message });
      } else if (!kickoffPosted) {
        // A delivered kickoff is already a complete visible handoff artifact.
        // Stay silent rather than append a generic closeout that duplicates it.
        await postReply({
          purpose: 'closeout',
          message:
            'I could not complete that request within the available turn.',
        });
      }
    }
    await mirrorPendingMessages();
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
    if (signal?.aborted) {
      if (canonicalConversationId) {
        fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
      }
      if (inferenceRetryReply) {
        await replaceInferenceRetryReply(
          {
            purpose: 'closeout',
            message:
              'The inference retry was interrupted before it completed. Please send the request again.',
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
        ? formatFastAgentInferenceFailure(error.failure)
        : 'I hit an error while handling that request. Please try again in a moment.';
    try {
      const reply = { purpose: 'closeout' as const, message };
      if (!(await replaceInferenceRetryReply(reply, true))) {
        await adapter.postReply(reply);
        turnVisibleMessages.push(buildAssistantTextMessage(message));
      }
      inferenceRetryReply = undefined;
      inferenceRetryMessageIndex = undefined;
      diagnostics.recordVisibleReply();
      lastVisibleMessage = message;
    } catch (postError) {
      console.error(
        `[Fast Agent] Failed to post error closeout: ${formatErrorForLog(postError)}`,
      );
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
    diagnostics.finish();
  }
}

export { FAST_AGENT_MODEL_ROLE };
export type { RoutableEnvironment };

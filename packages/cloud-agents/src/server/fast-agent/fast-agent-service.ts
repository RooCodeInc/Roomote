import type { ModelMessage } from 'ai';
import {
  BRAIN_MCP_ID,
  INFERENCE_PROVIDER_MAX_RETRIES,
  formatErrorForLog,
  resolveInferenceProviderRetryDelayMs,
  roomoteTaskInspectionArgsSchema,
} from '@roomote/types';
import { getDeploymentTaskModelOptions } from '@roomote/db/server';
import { z } from 'zod';

import {
  buildSlackThreadPromptBlocks,
  wrapSlackMessage,
  wrapSlackThreadContext,
  type SlackThreadPromptMessage,
} from '../../utils';
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
  generateTrackedNonTaskTextInOpenCodeSession,
  isNonTaskOpenCodePromptTimeoutError,
  isNonTaskOpenCodeSessionNotFoundError,
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
import {
  callFastAgentIntegration,
  listFastAgentIntegrations,
} from './fast-agent-integration-broker';
import {
  cancelFastAgentTask,
  inspectFastAgentTasks,
  sendFastAgentTaskMessage,
} from './fast-agent-tasks';
import { getFastAgentUserIdentity } from './fast-agent-user-identity';
import { FastAgentTurnDiagnostics } from './fast-agent-turn-diagnostics';
import {
  type FastAgentConversation,
  type FastAgentPlatformEventHandling,
  type FastAgentPlatformEventVisibility,
  type FastAgentReply,
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

function resolveFastAgentInferenceRetryDelayMs(
  error: unknown,
  failure: FastAgentInferenceFailure,
  retryNumber: number,
): number {
  return resolveInferenceProviderRetryDelayMs({
    error,
    attemptNumber: retryNumber,
    rateLimited: failure.reason === 'rate_limited',
  });
}

function formatFastAgentInferenceRetryNotice(
  notice: FastAgentInferenceRetryNotice,
): string {
  const headline =
    notice.failure.reason === 'rate_limited'
      ? 'Fast mode’s inference provider is rate limiting requests.'
      : notice.failure.reason === 'gateway_blocked'
        ? 'Fast mode’s request was blocked by the inference provider gateway.'
        : notice.failure.reason === 'timeout'
          ? 'Fast mode’s inference provider did not respond in time.'
          : 'Fast mode’s inference provider returned a temporary error.';

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
    case 'rate_limited':
      return 'Fast mode is still being rate limited by the inference provider after retrying. Any delegated tasks can keep running; please try again when provider capacity is available.';
    case 'timeout':
      return 'Fast mode’s inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.';
    case 'endpoint_unreachable':
      return 'Fast mode could not reach the inference provider after retrying. Please try again in a moment.';
    case 'gateway_blocked':
      return 'Fast mode’s request is still being blocked by the inference provider gateway after retrying. Please try again in a moment.';
    case 'insufficient_credits':
      return 'Fast mode cannot use the inference provider because the account has insufficient credits or quota.';
    case 'invalid_credentials':
      return 'Fast mode cannot authenticate with the configured inference provider. An administrator needs to reconnect or replace its credentials.';
    case 'model_unavailable':
      return 'Fast mode’s configured model is not available from the inference provider. An administrator needs to select an available model.';
    default:
      return 'Fast mode could not complete the request because its inference provider returned an error. Please try again in a moment.';
  }
}

function waitForFastAgentInferenceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function runFastAgentInferenceWithRetries<T>(
  run: () => Promise<T>,
  onRetry?: (notice: FastAgentInferenceRetryNotice) => Promise<void>,
  options: FastAgentInferenceRetryOptions = {},
): Promise<T> {
  for (
    let retryNumber = 0;
    retryNumber <= FAST_AGENT_INFERENCE_MAX_RETRIES;
    retryNumber += 1
  ) {
    try {
      return await run();
    } catch (error) {
      // Session loss is the session manager's bootstrap signal, not a
      // provider failure this loop should absorb.
      if (isNonTaskOpenCodeSessionNotFoundError(error)) {
        throw error;
      }

      const failure = classifyNonTaskInferenceError(error);
      if (
        !failure.retryable ||
        options.canRetry?.(error, failure) === false ||
        retryNumber >= FAST_AGENT_INFERENCE_MAX_RETRIES
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
        `[Fast Agent] Retrying inference failure attempt=${attemptNumber}/${FAST_AGENT_INFERENCE_MAX_RETRIES} delayMs=${delayMs} reason=${failure.reason}: ${formatErrorForLog(error)}`,
      );
      try {
        await onRetry?.({
          failure,
          attemptNumber,
          maxAttempts: FAST_AGENT_INFERENCE_MAX_RETRIES,
          delayMs,
        });
      } catch (noticeError) {
        console.warn(
          `[Fast Agent] Failed to post inference retry notice: ${formatErrorForLog(noticeError)}`,
        );
      }
      await options.prepareRetry?.();
      await waitForFastAgentInferenceRetry(delayMs);
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
  let launchedTaskMessage: string | null = null;
  let lastVisibleMessage = '';

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
    });
    const integrationCallSignatures = new Set<string>();
    const completedTaskActions = new Set<string>();
    let visibleUpdatePosted = false;
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
      await adapter.postReply(reply);
      diagnostics.recordVisibleReply();
      turnVisibleMessages.push(buildAssistantTextMessage(reply.message));
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
      await adapter.postReply({ purpose: 'progress', message });
      diagnostics.recordVisibleReply();
      turnVisibleMessages.push(buildAssistantTextMessage(message));
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
            if (completedTaskActions.has('launch_task')) {
              return { success: false, error: 'A task was already launched.' };
            }
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
            completedTaskActions.add('launch_task');
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
                { purpose: 'closeout', message, kickoff: true },
                true,
              );
              kickoffDelivered = true;
              launchedTaskMessage = message;
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
              if (!kickoffDelivered) {
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
        let unbind: (() => void) | undefined;
        let promptForAttempt = selectedPrompt;
        try {
          return await runFastAgentInferenceWithRetries(
            () =>
              generateTrackedNonTaskTextInOpenCodeSession(
                {
                  userId,
                  surface:
                    NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
                  modelRole: FAST_AGENT_MODEL_ROLE,
                  timeoutMs: null,
                  maxProviderRetryAttempts: FAST_AGENT_INFERENCE_MAX_RETRIES,
                  system,
                  prompt: promptForAttempt,
                  onProviderRetry: reportProviderRetryEvent,
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
                  signal,
                  tools: FAST_AGENT_NATIVE_TOOL_FILTER,
                  onModelResolved: (model) => {
                    diagnostics.recordModelResolved(model);
                  },
                  onPromptStarted: () => {
                    diagnostics.markInferenceStarted();
                  },
                  onSessionReady: (openCodeSessionID) => {
                    unbind?.();
                    unbind = bindFastAgentNativeToolExecutor(
                      openCodeSessionID,
                      executeNativeTool,
                    );
                  },
                },
              ),
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
              },
            },
          );
        } finally {
          unbind?.();
        }
      },
    });
    const promptText = await promptTextPromise.finally(() => {
      diagnostics.markInferenceFinished();
    });

    throwIfTurnCancelled();
    if (!closed) {
      const message =
        promptText.trim() ||
        'I could not complete that request within the available turn.';
      await postReply({ purpose: 'closeout', message });
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
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    if (canonicalConversationId) {
      // The system-posted closeout below is mirrored to compatibility history,
      // not to OpenCode's live transcript. Force the next turn to bootstrap so
      // the model can see the failure the user saw in Slack or Discord.
      fastAgentOpenCodeSessionManager.invalidate(canonicalConversationId);
    }
    if (platformEvent) throw error;

    const message = launchedTaskMessage
      ? 'I posted the task kickoff, but the task could not be queued. Please retry.'
      : error instanceof FastAgentInferenceError
        ? formatFastAgentInferenceFailure(error.failure)
        : 'I hit an error while handling that request. Please try again in a moment.';
    try {
      await adapter.postReply({ purpose: 'closeout', message });
      diagnostics.recordVisibleReply();
      turnVisibleMessages.push(buildAssistantTextMessage(message));
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

import { sdk, type TaskRun } from '@roomote/sdk/client';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getDiscordIntakeAckReactionTargetFromTaskPayload,
  getFastAgentParentFromPayload,
  type CommunicationProvider,
} from '@roomote/types';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task/types';
import {
  getRequestUserInputPromptSignature,
  isOpenCodeQuestionPlaceholderRequest,
  supportsIntegrationRequestUserInput,
} from './request-user-input';

// AgentMail (email) renders request_user_input as a question email whose
// options are signed one-click answer links, with free-text reply as the
// fallback; the other providers use interactive chat prompts.
const COMMUNICATION_RUI_PROVIDERS = new Set<CommunicationProvider>([
  'discord',
  'telegram',
  'teams',
  'agentmail',
]);

function supportsCommunicationRequestUserInput(
  provider: CommunicationProvider | null | undefined,
  taskRun?: TaskRun,
): boolean {
  return Boolean(
    provider &&
    (COMMUNICATION_RUI_PROVIDERS.has(provider) ||
      (provider === 'slack' &&
        taskRun &&
        getFastAgentParentFromPayload(taskRun.payload))),
  );
}

function supportsCommunicationAckReactionCleanup(taskRun: TaskRun): boolean {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (provider !== 'discord') {
    return false;
  }

  // Wire onStart when intake or snapshot-wake pinned eyes on a durable target.
  return (
    getDiscordIntakeAckReactionTargetFromTaskPayload(taskRun.payload) !== null
  );
}

function getRequestUserInputPromptSignatures(
  context: RunTaskContext,
): Map<string, string> {
  const existing = context.postedRequestUserInputSignatures;
  if (existing instanceof Map) {
    return existing;
  }

  const next = new Map<string, string>();
  context.postedRequestUserInputSignatures = next;
  return next;
}

function getConversationId(taskRun: TaskRun): string | null {
  const threadId = getCommunicationThreadIdFromTaskPayload(taskRun.payload);
  const channelId = getCommunicationChannelFromTaskPayload(taskRun.payload);
  return threadId?.trim() || channelId?.trim() || null;
}

async function clearCommunicationAckReactionOnStart(
  taskRun: TaskRun,
): Promise<void> {
  if (!supportsCommunicationAckReactionCleanup(taskRun)) {
    return;
  }

  try {
    await sdk.taskRuns.clearCommunicationAckReaction({
      runId: taskRun.id,
    });
  } catch (error) {
    console.error(
      `[communicationCallbacks#onStart] Failed discord ack reaction cleanup for task run ${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function handleRequestUserInput(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'request_user_input' },
  context: RunTaskContext,
): Promise<void> {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (!provider || !supportsCommunicationRequestUserInput(provider, taskRun)) {
    return;
  }

  const postedSignatures = getRequestUserInputPromptSignatures(context);
  const promptSignature = getRequestUserInputPromptSignature(event.request);

  if (postedSignatures.get(event.request.requestId) === promptSignature) {
    return;
  }

  // OpenCode streams the question tool before options land. Skip the empty
  // shell so chat surfaces only show the real structured prompt.
  if (isOpenCodeQuestionPlaceholderRequest(event.request)) {
    return;
  }

  try {
    if (!supportsIntegrationRequestUserInput(event.request)) {
      postedSignatures.set(event.request.requestId, promptSignature);
      return;
    }

    if (provider === 'slack') {
      const result = await sdk.taskRuns.publishFastAgentRequestUserInput({
        runId: taskRun.id,
        requestId: event.request.requestId,
        taskId: taskRun.taskId,
        questions: event.request.questions,
      });
      if (!result.published) {
        return;
      }
    } else {
      await sdk.taskRuns.publishCommunicationRequestUserInput({
        runId: taskRun.id,
        requestId: event.request.requestId,
        taskId: taskRun.taskId,
        questions: event.request.questions,
      });
    }
    postedSignatures.set(event.request.requestId, promptSignature);
  } catch (error) {
    console.error(
      `[communicationCallbacks] Failed to publish ${provider} request_user_input: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function handleRequestUserInputResponse(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'request_user_input_response' },
): Promise<void> {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (!provider || !supportsCommunicationRequestUserInput(provider, taskRun)) {
    return;
  }

  const conversationId = getConversationId(taskRun);
  if (!conversationId) {
    return;
  }

  try {
    if (provider === 'slack') {
      await sdk.taskRuns.clearPendingSlackRequestUserInput({
        runId: taskRun.id,
        threadId: conversationId,
        requestId: event.response.requestId,
      });
    } else {
      await sdk.taskRuns.clearPendingCommunicationRequestUserInput({
        runId: taskRun.id,
        provider,
        conversationId,
        requestId: event.response.requestId,
      });
    }
  } catch (error) {
    console.error(
      `[communicationCallbacks] Failed to clear ${provider} request_user_input state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function getCommunicationRunTaskCallbacks(
  taskRun: TaskRun,
): RunTaskCallbacks {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (!provider) {
    return {};
  }
  const supportsRui = supportsCommunicationRequestUserInput(provider, taskRun);
  const supportsAckCleanup = supportsCommunicationAckReactionCleanup(taskRun);

  if (!supportsRui && !supportsAckCleanup) {
    return {};
  }

  return {
    ...(supportsAckCleanup
      ? {
          onStart: async (run) => {
            await clearCommunicationAckReactionOnStart(run);
          },
        }
      : {}),
    ...(supportsRui
      ? {
          onMessage: async (run, _taskId, event, context) => {
            if (event.type === 'request_user_input') {
              await handleRequestUserInput(run, event, context);
            }
            if (event.type === 'request_user_input_response') {
              await handleRequestUserInputResponse(run, event);
            }
          },
          onExit: async (run) => {
            const conversationId = getConversationId(run);
            if (!conversationId) {
              return;
            }
            try {
              if (provider === 'slack') {
                await sdk.taskRuns.clearPendingSlackRequestUserInput({
                  runId: run.id,
                  threadId: conversationId,
                });
              } else {
                await sdk.taskRuns.clearPendingCommunicationRequestUserInput({
                  runId: run.id,
                  provider,
                  conversationId,
                });
              }
            } catch (error) {
              console.error(
                `[communicationCallbacks#onExit] Failed to clear ${provider} request_user_input: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          },
        }
      : {}),
  };
}

export function mergeRunTaskCallbacks(
  ...callbackSets: RunTaskCallbacks[]
): RunTaskCallbacks {
  const sets = callbackSets.filter(
    (set) => set.onStart || set.onMessage || set.onExit || set.onStatus,
  );
  if (sets.length === 0) {
    return {};
  }
  if (sets.length === 1) {
    return sets[0]!;
  }

  return {
    onStart: async (taskRun, taskId, context) => {
      for (const set of sets) {
        await set.onStart?.(taskRun, taskId, context);
      }
    },
    onMessage: async (taskRun, taskId, event, context, deliveryContext) => {
      for (const set of sets) {
        await set.onMessage?.(taskRun, taskId, event, context, deliveryContext);
      }
    },
    onExit: async (taskRun, status, context) => {
      for (const set of sets) {
        await set.onExit?.(taskRun, status, context);
      }
    },
    onStatus: async (taskRun, status, context) => {
      for (const set of sets) {
        await set.onStatus?.(taskRun, status, context);
      }
    },
  };
}

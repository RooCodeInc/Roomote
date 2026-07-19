import { sdk, type TaskRun } from '@roomote/sdk/client';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task/types';
import {
  getRequestUserInputPromptSignature,
  supportsIntegrationRequestUserInput,
} from './request-user-input';

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

function getDiscordConversationId(taskRun: TaskRun): string | null {
  const threadId = getCommunicationThreadIdFromTaskPayload(taskRun.payload);
  const channelId = getCommunicationChannelFromTaskPayload(taskRun.payload);
  return threadId?.trim() || channelId?.trim() || null;
}

async function handleRequestUserInput(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'request_user_input' },
  context: RunTaskContext,
): Promise<void> {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (provider !== 'discord') {
    return;
  }

  const postedSignatures = getRequestUserInputPromptSignatures(context);
  const promptSignature = getRequestUserInputPromptSignature(event.request);

  if (postedSignatures.get(event.request.requestId) === promptSignature) {
    return;
  }

  try {
    if (!supportsIntegrationRequestUserInput(event.request)) {
      // Secrets stay on the task UI. Mark as handled so we do not spam Discord
      // with button prompts that cannot accept private answers.
      postedSignatures.set(event.request.requestId, promptSignature);
      return;
    }

    await sdk.taskRuns.publishDiscordRequestUserInput({
      runId: taskRun.id,
      requestId: event.request.requestId,
      taskId: taskRun.taskId,
      questions: event.request.questions,
    });
    postedSignatures.set(event.request.requestId, promptSignature);
  } catch (error) {
    console.error(
      `[communicationCallbacks] Failed to publish Discord request_user_input: ${
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
  if (provider !== 'discord') {
    return;
  }

  const conversationId = getDiscordConversationId(taskRun);
  if (!conversationId) {
    return;
  }

  try {
    await sdk.taskRuns.clearPendingCommunicationRequestUserInput({
      runId: taskRun.id,
      provider: 'discord',
      conversationId,
      requestId: event.response.requestId,
    });
  } catch (error) {
    console.error(
      `[communicationCallbacks] Failed to clear Discord request_user_input state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function getCommunicationRunTaskCallbacks(
  taskRun: TaskRun,
): RunTaskCallbacks {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (provider !== 'discord') {
    return {};
  }

  return {
    onMessage: async (run, _taskId, event, context) => {
      if (event.type === 'request_user_input') {
        await handleRequestUserInput(run, event, context);
      }
      if (event.type === 'request_user_input_response') {
        await handleRequestUserInputResponse(run, event);
      }
    },
    onExit: async (run) => {
      const conversationId = getDiscordConversationId(run);
      if (!conversationId) {
        return;
      }
      try {
        await sdk.taskRuns.clearPendingCommunicationRequestUserInput({
          runId: run.id,
          provider: 'discord',
          conversationId,
        });
      } catch (error) {
        console.error(
          `[communicationCallbacks#onExit] Failed to clear Discord request_user_input: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

export function mergeRunTaskCallbacks(
  ...callbackSets: RunTaskCallbacks[]
): RunTaskCallbacks {
  const sets = callbackSets.filter(
    (set) => set.onStart || set.onMessage || set.onExit,
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
    onMessage: async (taskRun, taskId, event, context) => {
      for (const set of sets) {
        await set.onMessage?.(taskRun, taskId, event, context);
      }
    },
    onExit: async (taskRun, status, context) => {
      for (const set of sets) {
        await set.onExit?.(taskRun, status, context);
      }
    },
  };
}

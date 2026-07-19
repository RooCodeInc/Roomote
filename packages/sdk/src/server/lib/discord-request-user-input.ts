import {
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputPromptText,
  getCommunicationRequestUserInputConversationId,
  setPendingCommunicationRequestUserInput,
  type PendingCommunicationRequestUserInput,
} from '@roomote/communication';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type AcpRequestUserInputQuestion,
} from '@roomote/types';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';

export async function publishDiscordRequestUserInput(params: {
  runId: number;
  taskId: string;
  payload: unknown;
  request: {
    requestId: string;
    questions: AcpRequestUserInputQuestion[];
  };
  existing?: PendingCommunicationRequestUserInput | null;
}): Promise<{ conversationId: string; promptMessageId: string | null }> {
  const channelId = getCommunicationChannelFromTaskPayload(params.payload);
  const threadId = getCommunicationThreadIdFromTaskPayload(params.payload);
  const conversationId = getCommunicationRequestUserInputConversationId({
    channelId,
    threadId,
  });

  if (!conversationId || !channelId) {
    throw new Error(
      'Discord task run is missing communication channel context for request_user_input',
    );
  }

  const currentQuestionIndex = params.existing?.currentQuestionIndex ?? 0;
  const promptState = {
    requestId: params.request.requestId,
    questions: params.request.questions,
    currentQuestionIndex,
  };

  await setPendingCommunicationRequestUserInput('discord', conversationId, {
    requestId: params.request.requestId,
    runId: params.runId,
    taskId: params.taskId,
    questions: params.request.questions,
    promptMessageId: params.existing?.promptMessageId,
    currentQuestionIndex,
    answers: params.existing?.answers,
  });

  const promptText = buildDiscordRequestUserInputPromptText(promptState);
  const buttons = buildDiscordRequestUserInputButtons({
    runId: params.runId,
    request: promptState,
  });

  const discord =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!discord) {
    throw new Error('Discord communication provider is not configured');
  }

  const postChannelId = threadId ? channelId : conversationId;
  let promptMessageId: string | null = null;

  if (params.existing?.promptMessageId) {
    try {
      await discord.editMessage({
        channelId: conversationId,
        messageId: params.existing.promptMessageId,
        text: promptText,
        ...(buttons ? { buttons } : {}),
      });
      promptMessageId = params.existing.promptMessageId;
    } catch {
      promptMessageId = null;
    }
  }

  if (!promptMessageId) {
    const posted = await discord.postMessage({
      channelId: postChannelId,
      ...(threadId ? { threadId } : {}),
      text: promptText,
      ...(buttons ? { buttons } : {}),
    });
    promptMessageId = posted.messageId;
  }

  if (promptMessageId) {
    await setPendingCommunicationRequestUserInput('discord', conversationId, {
      requestId: params.request.requestId,
      runId: params.runId,
      taskId: params.taskId,
      questions: params.request.questions,
      promptMessageId,
      currentQuestionIndex,
      answers: params.existing?.answers,
    });
  }

  return { conversationId, promptMessageId };
}

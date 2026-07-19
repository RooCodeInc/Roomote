import {
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputPromptText,
  getCommunicationRequestUserInputConversationId,
  getPendingCommunicationRequestUserInput,
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

  // Prefer caller-supplied existing, else any in-flight prompt for this run so
  // OpenCode placeholder -> richer-question updates edit one Discord message.
  const livePending =
    params.existing ??
    (await getPendingCommunicationRequestUserInput('discord', conversationId));
  const existingForEdit =
    livePending &&
    livePending.runId === params.runId &&
    livePending.status === 'pending' &&
    livePending.promptMessageId
      ? livePending
      : params.existing?.promptMessageId
        ? params.existing
        : null;

  const currentQuestionIndex = existingForEdit?.currentQuestionIndex ?? 0;
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
    promptMessageId: existingForEdit?.promptMessageId,
    currentQuestionIndex,
    answers: existingForEdit?.answers,
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

  if (existingForEdit?.promptMessageId) {
    try {
      await discord.editMessage({
        channelId: conversationId,
        messageId: existingForEdit.promptMessageId,
        text: promptText,
        ...(buttons ? { buttons } : {}),
      });
      promptMessageId = existingForEdit.promptMessageId;
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
      answers: existingForEdit?.answers,
    });
  }

  return { conversationId, promptMessageId };
}

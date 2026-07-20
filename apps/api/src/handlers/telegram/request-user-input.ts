import {
  buildDiscordAnsweredRequestUserInputText,
  buildDiscordCancelledRequestUserInputText,
  getDiscordRequestUserInputCurrentQuestion,
  getPendingCommunicationRequestUserInput,
  clearPendingCommunicationRequestUserInput,
  parseDiscordRequestUserInputAnswerCallbackData,
  parseDiscordRequestUserInputCancelCallbackData,
  submitPendingCommunicationRequestUserInputAnswer,
  type PendingCommunicationRequestUserInput,
} from '@roomote/communication';
import {
  parseAcpRequestUserInputAnswerReply,
  type AcpRequestUserInputAnswers,
} from '@roomote/types';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';
import { createTelegramCommunicationProviderFromRuntimeCredentials as createTelegramCommunicationProvider } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import {
  answerTelegramCallbackQueryBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';

async function submitPendingRui(
  conversationId: string,
  pendingRequest: PendingCommunicationRequestUserInput,
  answers: AcpRequestUserInputAnswers,
  userId: string,
): Promise<boolean> {
  return submitPendingCommunicationRequestUserInputAnswer(
    'telegram',
    conversationId,
    pendingRequest,
    {
      answers,
      userId,
      timestamp: Date.now(),
    },
  );
}

async function confirmAnswer(params: {
  chatId: string;
  threadId?: string | null;
  pendingRequest: PendingCommunicationRequestUserInput;
  answerText: string;
  cancelled?: boolean;
  messageId?: string;
}): Promise<void> {
  const current = getDiscordRequestUserInputCurrentQuestion(
    params.pendingRequest,
  );
  const confirmationText = params.cancelled
    ? buildDiscordCancelledRequestUserInputText()
    : current
      ? buildDiscordAnsweredRequestUserInputText({
          question: current.question,
          answer: params.answerText,
        })
      : `**Picked:** ${params.answerText}`;

  const messageId =
    params.pendingRequest.promptMessageId ?? params.messageId ?? null;
  if (messageId) {
    try {
      const provider = await createTelegramCommunicationProvider();
      if (provider) {
        await provider.editMessageText({
          channelId: params.chatId,
          messageId,
          text: confirmationText,
          buttons: [],
        });
        return;
      }
    } catch (error) {
      apiLogger.warn(
        `[telegram.request_user_input] Failed to update prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await postTelegramMessageBestEffort({
    chatId: params.chatId,
    threadId: params.threadId ?? undefined,
    text: confirmationText,
  });
}

export async function tryHandleTelegramRequestUserInputMessage(params: {
  activeRunId: number;
  userId: string;
  text: string;
  chatId: string;
  threadId?: string | null;
}): Promise<boolean> {
  const conversationId = params.threadId?.trim() || params.chatId;
  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'telegram',
    conversationId,
  );
  if (!pendingRequest) {
    return false;
  }
  if (pendingRequest.runId !== params.activeRunId) {
    await clearPendingCommunicationRequestUserInput(
      'telegram',
      conversationId,
      {
        requestId: pendingRequest.requestId,
      },
    ).catch(() => undefined);
    return false;
  }
  if (pendingRequest.status === 'submitted') {
    await postTelegramMessageBestEffort({
      chatId: params.chatId,
      threadId: params.threadId ?? undefined,
      text: 'I already received your answer. Please wait for the agent to continue.',
    });
    return true;
  }

  const parsedReply = parseAcpRequestUserInputAnswerReply(
    pendingRequest.questions,
    params.text,
  );
  if (!parsedReply) {
    return false;
  }

  const cancelled = parsedReply.resolution === 'cancelled';
  const answers = cancelled ? {} : parsedReply.answers;
  const answerText = cancelled
    ? 'cancel'
    : Object.values(parsedReply.answers)
        .flatMap((entry) => entry.answers)
        .join(', ');

  const queued = await setTrustedRunActingUserOnSuccess({
    runId: params.activeRunId,
    userId: params.userId,
    operation: async () =>
      submitPendingRui(conversationId, pendingRequest, answers, params.userId),
  });

  if (!queued) {
    await postTelegramMessageBestEffort({
      chatId: params.chatId,
      threadId: params.threadId ?? undefined,
      text: 'I already received your answer. Please wait for the agent to continue.',
    });
    return true;
  }

  await confirmAnswer({
    chatId: params.chatId,
    threadId: params.threadId,
    pendingRequest,
    answerText,
    cancelled,
  });
  return true;
}

export async function tryHandleTelegramRequestUserInputCallback(params: {
  customId: string | undefined;
  userId: string | null;
  chatId: string;
  threadId?: string | null;
  callbackQueryId: string;
  messageId?: string;
}): Promise<boolean> {
  const answer = parseDiscordRequestUserInputAnswerCallbackData(
    params.customId,
  );
  const cancel = parseDiscordRequestUserInputCancelCallbackData(
    params.customId,
  );
  if (!answer && !cancel) {
    return false;
  }

  if (!params.userId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.callbackQueryId,
      text: 'Link your Telegram account in Roomote before answering.',
    });
    return true;
  }

  const conversationId = params.threadId?.trim() || params.chatId;
  const runId = answer?.runId ?? cancel?.runId;
  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'telegram',
    conversationId,
  );

  if (!pendingRequest || pendingRequest.runId !== runId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.callbackQueryId,
      text: 'This prompt is no longer active.',
    });
    return true;
  }

  const expectedToken = pendingRequest.requestId.slice(-8);
  const receivedToken = answer?.requestToken ?? cancel?.requestToken;
  if (receivedToken !== expectedToken) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.callbackQueryId,
      text: 'This prompt is no longer active.',
    });
    return true;
  }

  if (pendingRequest.status === 'submitted') {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.callbackQueryId,
      text: 'I already received your answer.',
    });
    return true;
  }

  let answers: AcpRequestUserInputAnswers = {};
  let answerText = 'cancel';
  let cancelled = false;

  if (cancel) {
    cancelled = true;
  } else if (answer) {
    const current = getDiscordRequestUserInputCurrentQuestion(pendingRequest);
    if (
      !current ||
      pendingRequest.questions.length !== 1 ||
      answer.questionIndex !== current.questionIndex
    ) {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: params.callbackQueryId,
        text:
          pendingRequest.questions.length !== 1
            ? 'Reply with one answer per line for multi-question prompts.'
            : 'That option is no longer available.',
      });
      return true;
    }
    const option = current.question.options?.[answer.optionIndex];
    if (!option) {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: params.callbackQueryId,
        text: 'That option is no longer available.',
      });
      return true;
    }
    answers = { [current.question.id]: { answers: [option.label] } };
    answerText = option.label;
  }

  const queued = await setTrustedRunActingUserOnSuccess({
    runId: pendingRequest.runId,
    userId: params.userId,
    operation: async () =>
      submitPendingRui(conversationId, pendingRequest, answers, params.userId!),
  });

  if (!queued) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.callbackQueryId,
      text: 'I already received your answer.',
    });
    return true;
  }

  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: params.callbackQueryId,
    text: cancelled ? 'Cancelled.' : `Picked: ${answerText}`,
  });

  await confirmAnswer({
    chatId: params.chatId,
    threadId: params.threadId,
    pendingRequest,
    answerText,
    cancelled,
    messageId: params.messageId,
  });
  return true;
}

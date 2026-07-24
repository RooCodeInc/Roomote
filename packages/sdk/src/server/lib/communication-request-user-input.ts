import {
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputPromptText,
  getCommunicationRequestUserInputConversationId,
  getPendingCommunicationRequestUserInput,
  setPendingCommunicationRequestUserInput,
  type PendingCommunicationRequestUserInput,
} from '@roomote/communication';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type AcpRequestUserInputQuestion,
  type CommunicationProvider,
} from '@roomote/types';

import { getCommunicationProviderAdapter } from './communication-providers';

type SupportedCommunicationRuiProvider = 'discord' | 'telegram' | 'teams';

function isSupportedCommunicationRuiProvider(
  provider: CommunicationProvider | null | undefined,
): provider is SupportedCommunicationRuiProvider {
  return (
    provider === 'discord' || provider === 'telegram' || provider === 'teams'
  );
}

export async function publishCommunicationRequestUserInput(params: {
  runId: number;
  taskId: string;
  payload: unknown;
  request: {
    requestId: string;
    questions: AcpRequestUserInputQuestion[];
  };
  existing?: PendingCommunicationRequestUserInput | null;
}): Promise<{ conversationId: string; promptMessageId: string | null }> {
  const provider = getCommunicationProviderFromTaskPayload(params.payload);
  if (!isSupportedCommunicationRuiProvider(provider)) {
    throw new Error(
      `request_user_input publish is not supported for provider ${provider ?? 'unknown'}`,
    );
  }

  const channelId = getCommunicationChannelFromTaskPayload(params.payload);
  const threadId = getCommunicationThreadIdFromTaskPayload(params.payload);
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(params.payload);
  const conversationId = getCommunicationRequestUserInputConversationId({
    channelId,
    threadId,
  });

  if (!conversationId || !channelId) {
    throw new Error(
      `${provider} task run is missing communication channel context for request_user_input`,
    );
  }

  const livePending =
    params.existing ??
    (await getPendingCommunicationRequestUserInput(provider, conversationId));
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

  await setPendingCommunicationRequestUserInput(provider, conversationId, {
    requestId: params.request.requestId,
    runId: params.runId,
    taskId: params.taskId,
    questions: params.request.questions,
    promptMessageId: existingForEdit?.promptMessageId,
    currentQuestionIndex,
    answers: existingForEdit?.answers,
  });

  const promptText = buildDiscordRequestUserInputPromptText({
    ...promptState,
    // Telegram and Teams still collect multi-question answers in one text
    // reply, so retain the full form until their handlers support advancing.
    ...(provider === 'discord' ? {} : { showAllQuestions: true }),
  });
  // Discord is the only provider with a per-question callback flow.
  const buttons =
    provider !== 'discord'
      ? undefined
      : buildDiscordRequestUserInputButtons({
          runId: params.runId,
          request: promptState,
        });

  const adapter = await getCommunicationProviderAdapter(provider);
  if (!adapter) {
    throw new Error(`${provider} communication provider is not configured`);
  }

  let promptMessageId: string | null = null;

  if (existingForEdit?.promptMessageId) {
    try {
      promptMessageId = await editCommunicationPromptMessage({
        provider,
        adapter,
        conversationId,
        channelId,
        threadId,
        serviceUrl,
        messageId: existingForEdit.promptMessageId,
        text: promptText,
        buttons,
      });
    } catch {
      promptMessageId = null;
    }
  }

  if (!promptMessageId) {
    // channelId is always the chat/conversation destination. threadId is
    // only reply/topic scope (Telegram topics, Discord threads, Teams reply).
    const posted = await adapter.postMessage({
      channelId,
      ...(threadId && (provider === 'discord' || provider === 'telegram')
        ? { threadId }
        : {}),
      ...(provider === 'teams' && threadId
        ? { replyToMessageId: threadId }
        : {}),
      ...(serviceUrl ? { serviceUrl } : {}),
      text: promptText,
      ...(provider === 'teams' ? { textFormat: 'markdown' as const } : {}),
      ...(buttons ? { buttons } : {}),
    });
    promptMessageId = posted.messageId;
  }

  if (promptMessageId) {
    await setPendingCommunicationRequestUserInput(provider, conversationId, {
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

async function editCommunicationPromptMessage(params: {
  provider: SupportedCommunicationRuiProvider;
  adapter: Awaited<ReturnType<typeof getCommunicationProviderAdapter>>;
  conversationId: string;
  channelId: string;
  threadId?: string | null;
  serviceUrl?: string | null;
  messageId: string;
  text: string;
  buttons?: ReturnType<typeof buildDiscordRequestUserInputButtons>;
}): Promise<string | null> {
  if (!params.adapter) {
    return null;
  }

  if (params.provider === 'discord') {
    const discord = params.adapter as DiscordCommunicationProvider;
    await discord.editMessage({
      channelId: params.conversationId,
      messageId: params.messageId,
      text: params.text,
      ...(params.buttons ? { buttons: params.buttons } : {}),
    });
    return params.messageId;
  }

  if (params.provider === 'telegram') {
    const telegram = params.adapter as TelegramCommunicationProvider;
    await telegram.editMessageText({
      channelId: params.channelId,
      messageId: params.messageId,
      text: params.text,
      ...(params.buttons ? { buttons: params.buttons } : { buttons: [] }),
    });
    return params.messageId;
  }

  if (params.provider === 'teams') {
    const teams = params.adapter as TeamsCommunicationProvider;
    if (!params.serviceUrl) {
      return null;
    }
    await teams.updateMessage({
      channelId: params.channelId,
      messageId: params.messageId,
      serviceUrl: params.serviceUrl,
      text: params.text,
      textFormat: 'markdown',
    });
    return params.messageId;
  }

  return null;
}

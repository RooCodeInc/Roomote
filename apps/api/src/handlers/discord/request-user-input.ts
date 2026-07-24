import {
  advancePendingCommunicationRequestUserInputQuestion,
  buildDiscordAnsweredRequestUserInputText,
  buildDiscordCancelledRequestUserInputText,
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputPromptText,
  getDiscordRequestUserInputCurrentQuestion,
  getPendingCommunicationRequestUserInput,
  clearPendingCommunicationRequestUserInput,
  parseDiscordRequestUserInputAnswerCallbackData,
  parseDiscordRequestUserInputCancelCallbackData,
  submitPendingCommunicationRequestUserInputAnswer,
  type PendingCommunicationRequestUserInput,
} from '@roomote/communication';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import {
  parseAcpRequestUserInputAnswerReply,
  type AcpRequestUserInputAnswers,
} from '@roomote/types';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { replyToDiscordEvent } from './replies.js';
import type { DiscordChannelContext } from './task-launch.js';

function conversationIdForChannel(channel: DiscordChannelContext): string {
  return channel.channelId;
}

async function postAlreadyReceivedNotice(params: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  replyToMessageId?: string;
}): Promise<void> {
  await replyToDiscordEvent({
    provider: params.provider,
    applicationId: params.applicationId,
    channel: params.channel,
    ...(params.interaction ? { interaction: params.interaction } : {}),
    ...(params.replyToMessageId
      ? { replyToMessageId: params.replyToMessageId }
      : {}),
    text: 'I already received your answer. Please wait for the agent to continue.',
  });
}

async function finalizeDiscordRequestUserInputAnswer(params: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  activeRunId: number;
  pendingRequest: PendingCommunicationRequestUserInput;
  answers: AcpRequestUserInputAnswers;
  userId: string;
  answerText: string;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  replyToMessageId?: string;
  cancelled?: boolean;
}): Promise<'queued' | 'already_received'> {
  const conversationId = conversationIdForChannel(params.channel);
  const current = getDiscordRequestUserInputCurrentQuestion(
    params.pendingRequest,
  );

  // Atomically claim submitted + enqueue in Redis first (Slack-style), then
  // only the winning claim updates actingUserId. Concurrent losers return
  // false without double-enqueueing an answer.
  const queued = await setTrustedRunActingUserOnSuccess({
    runId: params.activeRunId,
    userId: params.userId,
    operation: async () =>
      submitPendingCommunicationRequestUserInputAnswer(
        'discord',
        conversationId,
        params.pendingRequest,
        {
          answers: params.answers,
          userId: params.userId,
          timestamp: Date.now(),
        },
      ),
  });

  if (!queued) {
    await postAlreadyReceivedNotice({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: params.interaction,
      replyToMessageId: params.replyToMessageId,
    });
    return 'already_received';
  }

  const confirmationText = params.cancelled
    ? buildDiscordCancelledRequestUserInputText()
    : current
      ? buildDiscordAnsweredRequestUserInputText({
          question: current.question,
          answer: params.answerText,
        })
      : `**Picked:** ${params.answerText}`;

  if (params.pendingRequest.promptMessageId) {
    try {
      await params.provider.editMessage({
        channelId: conversationId,
        messageId: params.pendingRequest.promptMessageId,
        text: confirmationText,
        buttons: [],
      });
      if (params.interaction) {
        await replyToDiscordEvent({
          provider: params.provider,
          applicationId: params.applicationId,
          channel: params.channel,
          interaction: params.interaction,
          text: params.cancelled
            ? 'Cancelled.'
            : `Picked: ${params.answerText}`,
          ephemeral: true,
        }).catch(() => undefined);
      }
      return 'queued';
    } catch (error) {
      apiLogger.warn(
        `[discord.request_user_input] Failed to update prompt message ${params.pendingRequest.promptMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await replyToDiscordEvent({
    provider: params.provider,
    applicationId: params.applicationId,
    channel: params.channel,
    ...(params.interaction ? { interaction: params.interaction } : {}),
    ...(params.replyToMessageId
      ? { replyToMessageId: params.replyToMessageId }
      : {}),
    text: confirmationText,
  });
  return 'queued';
}

async function advanceDiscordRequestUserInputQuestion(params: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  pendingRequest: PendingCommunicationRequestUserInput;
  answers: AcpRequestUserInputAnswers;
  answerText: string;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  replyToMessageId?: string;
}): Promise<'advanced' | 'already_received'> {
  const conversationId = conversationIdForChannel(params.channel);
  const current = getDiscordRequestUserInputCurrentQuestion(
    params.pendingRequest,
  );
  if (!current) {
    return 'already_received';
  }

  const nextQuestionIndex = current.questionIndex + 1;
  const advanced = await advancePendingCommunicationRequestUserInputQuestion(
    'discord',
    conversationId,
    params.pendingRequest,
    nextQuestionIndex,
    params.answers,
  );
  if (!advanced) {
    await postAlreadyReceivedNotice({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: params.interaction,
      replyToMessageId: params.replyToMessageId,
    });
    return 'already_received';
  }

  const nextPrompt = {
    requestId: params.pendingRequest.requestId,
    questions: params.pendingRequest.questions,
    currentQuestionIndex: nextQuestionIndex,
  };
  const nextPromptText = buildDiscordRequestUserInputPromptText(nextPrompt);
  let rendered = false;

  if (params.pendingRequest.promptMessageId) {
    try {
      await params.provider.editMessage({
        channelId: conversationId,
        messageId: params.pendingRequest.promptMessageId,
        text: nextPromptText,
        buttons: buildDiscordRequestUserInputButtons({
          runId: params.pendingRequest.runId,
          request: nextPrompt,
        }),
      });
      rendered = true;
    } catch (error) {
      apiLogger.warn(
        `[discord.request_user_input] Failed to advance prompt message ${params.pendingRequest.promptMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await replyToDiscordEvent({
    provider: params.provider,
    applicationId: params.applicationId,
    channel: params.channel,
    ...(params.interaction ? { interaction: params.interaction } : {}),
    ...(params.replyToMessageId
      ? { replyToMessageId: params.replyToMessageId }
      : {}),
    text: rendered
      ? `Picked: ${params.answerText}`
      : `Picked: ${params.answerText}\n\n${nextPromptText}`,
    ...(params.interaction ? { ephemeral: true } : {}),
  });
  return 'advanced';
}

/**
 * Try to treat an inbound Discord message as an answer to a pending
 * request_user_input prompt. Returns true when the message was consumed.
 */
export async function tryHandleDiscordRequestUserInputMessage(params: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  activeRun: { id: number };
  userId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<boolean> {
  const conversationId = conversationIdForChannel(params.channel);
  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'discord',
    conversationId,
  );

  if (!pendingRequest) {
    return false;
  }

  if (pendingRequest.runId !== params.activeRun.id) {
    await clearPendingCommunicationRequestUserInput('discord', conversationId, {
      requestId: pendingRequest.requestId,
    }).catch(() => undefined);
    return false;
  }

  if (pendingRequest.status === 'submitted') {
    await postAlreadyReceivedNotice({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      replyToMessageId: params.replyToMessageId,
    });
    return true;
  }

  const current = getDiscordRequestUserInputCurrentQuestion(pendingRequest);
  const parsedReply = parseAcpRequestUserInputAnswerReply(
    current ? [current.question] : pendingRequest.questions,
    params.text,
  );

  if (!parsedReply) {
    // Not a recognizable structured answer — fall through to normal follow-up.
    return false;
  }

  if (parsedReply.resolution === 'cancelled') {
    await finalizeDiscordRequestUserInputAnswer({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      activeRunId: params.activeRun.id,
      pendingRequest,
      answers: {},
      userId: params.userId,
      answerText: 'cancel',
      replyToMessageId: params.replyToMessageId,
      cancelled: true,
    });
    return true;
  }

  if (current && pendingRequest.questions.length > 1) {
    const answers = {
      ...(pendingRequest.answers ?? {}),
      ...parsedReply.answers,
    };
    const nextQuestionIndex = current.questionIndex + 1;

    if (nextQuestionIndex < pendingRequest.questions.length) {
      await advanceDiscordRequestUserInputQuestion({
        provider: params.provider,
        applicationId: params.applicationId,
        channel: params.channel,
        pendingRequest,
        answers,
        answerText: Object.values(parsedReply.answers)
          .flatMap((entry) => entry.answers)
          .join(', '),
        replyToMessageId: params.replyToMessageId,
      });
      return true;
    }

    await finalizeDiscordRequestUserInputAnswer({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      activeRunId: params.activeRun.id,
      pendingRequest,
      answers,
      userId: params.userId,
      answerText: Object.values(parsedReply.answers)
        .flatMap((entry) => entry.answers)
        .join(', '),
      replyToMessageId: params.replyToMessageId,
    });
    return true;
  }

  await finalizeDiscordRequestUserInputAnswer({
    provider: params.provider,
    applicationId: params.applicationId,
    channel: params.channel,
    activeRunId: params.activeRun.id,
    pendingRequest,
    answers: parsedReply.answers,
    userId: params.userId,
    answerText: Object.values(parsedReply.answers)
      .flatMap((entry) => entry.answers)
      .join(', '),
    replyToMessageId: params.replyToMessageId,
  });
  return true;
}

/**
 * Handle Discord button clicks for request_user_input prompts.
 * Returns true when the interaction was consumed.
 */
export async function tryHandleDiscordRequestUserInputCallback(params: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  customId: string | undefined;
  userId: string | null;
}): Promise<boolean> {
  const answerCallback = parseDiscordRequestUserInputAnswerCallbackData(
    params.customId,
  );
  const cancelCallback = parseDiscordRequestUserInputCancelCallbackData(
    params.customId,
  );

  if (!answerCallback && !cancelCallback) {
    return false;
  }

  if (!params.userId) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: {
        interaction: params.interaction,
        interactionDeferred: params.interactionDeferred,
      },
      text: 'Link your Discord account in Roomote before answering.',
      ephemeral: true,
    });
    return true;
  }

  const conversationId = conversationIdForChannel(params.channel);
  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'discord',
    conversationId,
  );
  const runId = answerCallback?.runId ?? cancelCallback?.runId;

  if (!pendingRequest || pendingRequest.runId !== runId) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: {
        interaction: params.interaction,
        interactionDeferred: params.interactionDeferred,
      },
      text: 'This prompt is no longer active.',
      ephemeral: true,
    });
    return true;
  }

  const expectedToken = pendingRequest.requestId.slice(-8);
  const receivedToken =
    answerCallback?.requestToken ?? cancelCallback?.requestToken;
  if (receivedToken !== expectedToken) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: {
        interaction: params.interaction,
        interactionDeferred: params.interactionDeferred,
      },
      text: 'This prompt is no longer active.',
      ephemeral: true,
    });
    return true;
  }

  if (pendingRequest.status === 'submitted') {
    await postAlreadyReceivedNotice({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: {
        interaction: params.interaction,
        interactionDeferred: params.interactionDeferred,
      },
    });
    return true;
  }

  const interactionCtx = {
    interaction: params.interaction,
    interactionDeferred: params.interactionDeferred,
  };

  if (cancelCallback) {
    await finalizeDiscordRequestUserInputAnswer({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      activeRunId: pendingRequest.runId,
      pendingRequest,
      answers: {},
      userId: params.userId,
      answerText: 'cancel',
      interaction: interactionCtx,
      cancelled: true,
    });
    return true;
  }

  const current = getDiscordRequestUserInputCurrentQuestion(pendingRequest);
  if (!current || !answerCallback) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: interactionCtx,
      text: 'This prompt is no longer active.',
      ephemeral: true,
    });
    return true;
  }

  if (answerCallback.questionIndex !== current.questionIndex) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: interactionCtx,
      text: 'That option is for an earlier question. Please pick from the latest prompt.',
      ephemeral: true,
    });
    return true;
  }

  const option = current.question.options?.[answerCallback.optionIndex];
  if (!option) {
    await replyToDiscordEvent({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      interaction: interactionCtx,
      text: 'That option is no longer available.',
      ephemeral: true,
    });
    return true;
  }

  const answers: AcpRequestUserInputAnswers = {
    ...(pendingRequest.answers ?? {}),
    [current.question.id]: { answers: [option.label] },
  };

  const nextQuestionIndex = current.questionIndex + 1;
  if (nextQuestionIndex < pendingRequest.questions.length) {
    await advanceDiscordRequestUserInputQuestion({
      provider: params.provider,
      applicationId: params.applicationId,
      channel: params.channel,
      pendingRequest,
      answers,
      answerText: option.label,
      interaction: interactionCtx,
    });
    return true;
  }

  await finalizeDiscordRequestUserInputAnswer({
    provider: params.provider,
    applicationId: params.applicationId,
    channel: params.channel,
    activeRunId: pendingRequest.runId,
    pendingRequest,
    answers,
    userId: params.userId,
    answerText: option.label,
    interaction: interactionCtx,
  });
  return true;
}

export function hasPendingDiscordRequestUserInputCallback(
  customId: string | undefined,
): boolean {
  return (
    parseDiscordRequestUserInputAnswerCallbackData(customId) !== null ||
    parseDiscordRequestUserInputCancelCallbackData(customId) !== null
  );
}

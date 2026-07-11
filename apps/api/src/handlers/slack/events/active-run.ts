import {
  type AcpRequestUserInputAnswers,
  parseAcpRequestUserInputAnswerReply,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  appendSlackVideoDescriptionsToText,
  clearLatestUserMessage,
  clearPendingSlackRequestUserInput,
  buildSlackAnsweredRequestUserInputBlocks,
  buildSlackRequestUserInputBlocks,
  collectAndProcessThreadImages,
  getPromptReadyThreadMessages,
  getLatestSlackBotReply,
  getPendingSlackRequestUserInput,
  getSlackRequestUserInputCurrentQuestion,
  getSlackThreadFooterText,
  queueSlackMessage,
  resolveCurrentSlackMessageFiles,
  type SlackThreadMessage,
  type SlackEvent,
  type SlackNotifier,
  setPendingSlackRequestUserInputPromptMessageTs,
  SlackThreadDeliveryTracker,
  submitPendingSlackRequestUserInputAnswer,
  advancePendingSlackRequestUserInputQuestion,
} from '@roomote/slack';
import {
  appendAttachmentTextsToPromptText,
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';

import { apiLogger } from '../../../logging.js';
import { syncActingUserForInboundMessage } from '../../tasks/acting-user-sync.js';
import {
  buildResolvedCurrentMessageText,
  processSlackAttachments,
} from '../helpers/attachments.js';
import { getIsSlackDiverged } from '../helpers/thread-sync.js';

type ActiveSlackTaskRun = {
  id: number;
  actingUserId: string | null;
  result: unknown;
  taskId: string | null;
  payload?: unknown;
};

const REQUEST_USER_INPUT_ALREADY_RECEIVED_TEXT =
  '_I already received your answer. Please wait for the agent to continue._';

function buildSlackRequestUserInputTaskUrl(
  activeRun: ActiveSlackTaskRun,
): string {
  const origin = Env.ROOMOTE_APP_URL;
  const payload =
    activeRun.payload && typeof activeRun.payload === 'object'
      ? (activeRun.payload as { webPath?: unknown })
      : null;
  const webPath =
    typeof payload?.webPath === 'string' && payload.webPath.startsWith('/')
      ? payload.webPath
      : null;
  const baseUrl =
    webPath || activeRun.taskId
      ? `${origin}${webPath ?? `/task/${activeRun.taskId}`}`
      : `${origin}/task`;
  const url = new URL(baseUrl);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'integration');
  url.searchParams.set('utm_campaign', 'request_user_input');

  return url.toString();
}

async function postRequestUserInputAlreadyReceivedMessage(params: {
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  deliveryTracker: SlackThreadDeliveryTracker;
  eventTs: string;
}): Promise<void> {
  await params.slack.postMessage({
    channel: params.channel,
    thread_ts: params.threadId,
    blocks: [
      {
        type: 'markdown',
        text: REQUEST_USER_INPUT_ALREADY_RECEIVED_TEXT,
      },
    ],
  });
  params.deliveryTracker.track(params.eventTs);
}

async function handlePendingRequestUserInputReply(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  userId: string;
  activeRun: ActiveSlackTaskRun;
  threadId: string;
  pendingRequest: NonNullable<
    Awaited<ReturnType<typeof getPendingSlackRequestUserInput>>
  >;
  deliveryTracker: SlackThreadDeliveryTracker;
}): Promise<'handled' | 'forward'> {
  const {
    event,
    slack,
    userId,
    activeRun,
    threadId,
    pendingRequest,
    deliveryTracker,
  } = params;

  const messageText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(stripLeadingRawSlackMention(event.text)),
  );
  const currentQuestion =
    getSlackRequestUserInputCurrentQuestion(pendingRequest);
  const remainingQuestions =
    currentQuestion === null
      ? []
      : pendingRequest.questions.slice(currentQuestion.questionIndex);
  const parsedReply = parseAcpRequestUserInputAnswerReply(
    remainingQuestions,
    messageText,
  );

  if (!parsedReply) {
    const parsedCurrentQuestionReply =
      currentQuestion === null
        ? null
        : parseAcpRequestUserInputAnswerReply(
            [currentQuestion.question],
            messageText,
          );

    if (!parsedCurrentQuestionReply) {
      return 'forward';
    }

    if (parsedCurrentQuestionReply.resolution === 'cancelled') {
      const submitted = await setTrustedRunActingUserOnSuccess({
        runId: activeRun.id,
        userId,
        operation: async () =>
          await submitPendingSlackRequestUserInputAnswer(
            threadId,
            pendingRequest,
            {
              answers: {},
              user: event.user,
              userId,
              ts: event.ts,
            },
          ),
      });

      if (!submitted) {
        await postRequestUserInputAlreadyReceivedMessage({
          slack,
          channel: event.channel,
          threadId,
          deliveryTracker,
          eventTs: event.ts,
        });
        return 'handled';
      }

      await slack.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        blocks: [
          {
            type: 'markdown',
            text: '**Cancelled the question.**',
          },
        ],
      });

      apiLogger.debug(
        `✅ Successfully cancelled request_user_input for active task run ${activeRun.id}`,
      );
      deliveryTracker.track(event.ts);
      return 'handled';
    }

    if (!currentQuestion) {
      deliveryTracker.track(event.ts);
      return 'handled';
    }

    const nextAnswers: AcpRequestUserInputAnswers = {
      ...pendingRequest.answers,
      ...parsedCurrentQuestionReply.answers,
    };
    const selectedAnswer =
      parsedCurrentQuestionReply.answers[currentQuestion.question.id]
        ?.answers[0];
    const nextQuestionIndex = (currentQuestion.questionIndex ?? 0) + 1;

    if (nextQuestionIndex >= pendingRequest.questions.length) {
      const submitted = await setTrustedRunActingUserOnSuccess({
        runId: activeRun.id,
        userId,
        operation: async () =>
          await submitPendingSlackRequestUserInputAnswer(
            threadId,
            pendingRequest,
            {
              answers: nextAnswers,
              user: event.user,
              userId,
              ts: event.ts,
            },
          ),
      });

      if (!submitted) {
        await postRequestUserInputAlreadyReceivedMessage({
          slack,
          channel: event.channel,
          threadId,
          deliveryTracker,
          eventTs: event.ts,
        });
        return 'handled';
      }

      if (pendingRequest.promptMessageTs && selectedAnswer) {
        await slack.updateMessage({
          channel: event.channel,
          ts: pendingRequest.promptMessageTs,
          message: {
            blocks: buildSlackAnsweredRequestUserInputBlocks({
              question: currentQuestion.question,
              answer: selectedAnswer,
            }),
          },
        });
      }

      apiLogger.debug(
        `✅ Successfully queued final request_user_input answer for active task run ${activeRun.id}`,
      );
      deliveryTracker.track(event.ts);
      return 'handled';
    }

    const advanced = await advancePendingSlackRequestUserInputQuestion(
      threadId,
      pendingRequest,
      nextQuestionIndex,
      nextAnswers,
    );

    if (!advanced) {
      await postRequestUserInputAlreadyReceivedMessage({
        slack,
        channel: event.channel,
        threadId,
        deliveryTracker,
        eventTs: event.ts,
      });
      return 'handled';
    }

    if (pendingRequest.promptMessageTs && selectedAnswer) {
      await slack.updateMessage({
        channel: event.channel,
        ts: pendingRequest.promptMessageTs,
        message: {
          blocks: buildSlackAnsweredRequestUserInputBlocks({
            question: currentQuestion.question,
            answer: selectedAnswer,
          }),
        },
      });
    }

    const nextPromptMessageTs = await slack.postMessage({
      channel: event.channel,
      thread_ts: threadId,
      blocks: buildSlackRequestUserInputBlocks({
        requestId: pendingRequest.requestId,
        questions: pendingRequest.questions,
        currentQuestionIndex: nextQuestionIndex,
        answers: nextAnswers,
        footerText: await getSlackThreadFooterText({
          taskUrl: buildSlackRequestUserInputTaskUrl(activeRun),
          taskId: activeRun.taskId,
          prRepo: null,
          prNumber: null,
          channelId: event.channel,
          threadTs: threadId,
        }),
      }),
    });

    if (nextPromptMessageTs) {
      await setPendingSlackRequestUserInputPromptMessageTs(
        threadId,
        pendingRequest.requestId,
        nextQuestionIndex,
        nextPromptMessageTs,
      );
    }
    deliveryTracker.track(event.ts);

    return 'handled';
  }

  const mergedAnswers: AcpRequestUserInputAnswers = {
    ...pendingRequest.answers,
    ...parsedReply.answers,
  };
  const selectedAnswer = currentQuestion?.question
    ? parsedReply.answers[currentQuestion.question.id]?.answers[0]
    : undefined;

  const submitted = await setTrustedRunActingUserOnSuccess({
    runId: activeRun.id,
    userId,
    operation: async () =>
      await submitPendingSlackRequestUserInputAnswer(threadId, pendingRequest, {
        answers: parsedReply.resolution === 'cancelled' ? {} : mergedAnswers,
        user: event.user,
        userId,
        ts: event.ts,
      }),
  });

  if (!submitted) {
    await postRequestUserInputAlreadyReceivedMessage({
      slack,
      channel: event.channel,
      threadId,
      deliveryTracker,
      eventTs: event.ts,
    });
    return 'handled';
  }

  if (pendingRequest.promptMessageTs && currentQuestion && selectedAnswer) {
    await slack.updateMessage({
      channel: event.channel,
      ts: pendingRequest.promptMessageTs,
      message: {
        blocks: buildSlackAnsweredRequestUserInputBlocks({
          question: currentQuestion.question,
          answer: selectedAnswer,
        }),
      },
    });
  }

  if (parsedReply.resolution === 'cancelled') {
    await slack.postMessage({
      channel: event.channel,
      thread_ts: threadId,
      blocks: [
        {
          type: 'markdown',
          text: '**Cancelled the question.**',
        },
      ],
    });
  }

  apiLogger.debug(
    `✅ Successfully queued request_user_input answer for active task run ${activeRun.id}`,
  );
  deliveryTracker.track(event.ts);
  return 'handled';
}

export async function processActiveRunMessage(
  event: SlackEvent,
  slack: SlackNotifier,
  userId: string,
  activeRun: ActiveSlackTaskRun,
  botUserId?: string,
  prefetchedThreadMessages?: SlackThreadMessage[],
): Promise<void> {
  const threadId = event.thread_ts || event.ts;
  const pendingRequest = await getPendingSlackRequestUserInput(threadId);
  const deliveryTracker = new SlackThreadDeliveryTracker(
    event.channel,
    threadId,
  );

  try {
    if (pendingRequest) {
      if (pendingRequest.runId !== activeRun.id) {
        await clearPendingSlackRequestUserInput(threadId, {
          requestId: pendingRequest.requestId,
        }).catch(() => {});
      } else if (pendingRequest.status === 'submitted') {
        await postRequestUserInputAlreadyReceivedMessage({
          slack,
          channel: event.channel,
          threadId,
          deliveryTracker,
          eventTs: event.ts,
        });
        return;
      } else {
        const outcome = await handlePendingRequestUserInputReply({
          event,
          slack,
          userId,
          activeRun,
          threadId,
          pendingRequest,
          deliveryTracker,
        });

        if (outcome === 'handled') {
          return;
        }
        // 'forward': the reply is not a recognizable answer to the pending
        // question, so fall through and deliver it to the agent as a normal
        // thread message instead of blocking it behind the question.
      }
    }

    const [promptReadyThreadMessages, normalizedMessageText, trackedBotReply] =
      await Promise.all([
        getPromptReadyThreadMessages({
          slack,
          channel: event.channel,
          threadTs: threadId,
          botUserId,
          startedMessageRunId: activeRun.id,
          logContext: `active task run ${activeRun.id} in ${event.channel}:${threadId}`,
          prefetchedMessages: prefetchedThreadMessages,
        }),
        slack.normalizeIncomingText(stripLeadingRawSlackMention(event.text)),
        getLatestSlackBotReply(event.channel, threadId),
      ]);
    const messageText = stripLeadingSlackProductMention(normalizedMessageText);
    const currentMessageFiles = resolveCurrentSlackMessageFiles({
      currentMessageTs: event.ts,
      eventFiles: event.files,
      messages: promptReadyThreadMessages.messages,
    });
    const promptRelevantThreadMessages =
      promptReadyThreadMessages.promptRelevantMessages;
    const attachments = await processSlackAttachments({
      slack,
      files: currentMessageFiles,
      userId: activeRun.actingUserId ?? undefined,
      userTextContext: stripLeadingSlackProductMention(
        stripLeadingRawSlackMention(event.text),
      ),
    });
    const currentMessageTextWithVideoDescriptions =
      appendSlackVideoDescriptionsToText({
        text: appendAttachmentTextsToPromptText({
          text: messageText,
          attachmentTexts: attachments.attachmentTexts,
        }),
        videoDescriptions: attachments.videoDescriptions,
      });
    const excludeFileIds = currentMessageFiles
      ? new Set(currentMessageFiles.map((file) => file.id))
      : undefined;
    const isSlackDiverged = await getIsSlackDiverged({
      runId: activeRun.id,
      trackedBotReply,
    });
    const {
      currentMessageText: messageTextWithVideoDescriptions,
      claimedImageUris,
      formattedPrompt,
      turnPolicy,
    } = await deliveryTracker.buildContinuationPrompt({
      currentMessageTs: event.ts,
      currentMessageText: currentMessageTextWithVideoDescriptions,
      resolveCurrentMessageText: (claimedMessages) =>
        buildResolvedCurrentMessageText({
          slack,
          claimedMessages,
          excludeFileIds,
          logContext: `active task run ${activeRun.id} in ${event.channel}:${threadId}`,
          userId: activeRun.actingUserId ?? undefined,
          messageText,
          currentAttachmentTexts: attachments.attachmentTexts,
          currentVideoDescriptions: attachments.videoDescriptions,
        }),
      fetchThreadMessages: async () => promptRelevantThreadMessages,
      normalizeMessageText: (text) => slack.normalizeIncomingText(text),
      processMessageFiles: (messages) =>
        collectAndProcessThreadImages({
          processSlackFiles: (files) => slack.processSlackFiles(files),
          messages,
          excludeFileIds,
          logContext: `active task run ${activeRun.id} in ${event.channel}:${threadId}`,
        }),
      getTrackedBotReply: async () => trackedBotReply,
      isSlackDiverged,
      botUserId,
    });
    const allImages = [...attachments.images, ...claimedImageUris];

    try {
      // Trusted pre-queue actor switch: the worker only runs this message's
      // turn as `userId` if the server-side acting user already points at
      // them (run tokens can no longer write actingUserId themselves).
      await syncActingUserForInboundMessage({
        logContext: 'slack.processActiveRunMessage',
        runId: activeRun.id,
        senderUserId: userId,
      });
      await queueSlackMessage(activeRun.id, {
        text: messageTextWithVideoDescriptions,
        user: event.user,
        userId,
        ts: event.ts,
        images: allImages.length > 0 ? allImages : undefined,
        formattedPrompt,
        turnPolicy,
      });
      await clearLatestUserMessage(activeRun.id);
    } catch (error) {
      await deliveryTracker.rollback().catch(() => {});
      throw error;
    }
    deliveryTracker.track(event.ts);

    apiLogger.debug(
      `✅ Successfully queued message for active task run ${activeRun.id}`,
    );
  } finally {
    await deliveryTracker.commit();
  }
}

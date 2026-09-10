import { createHash } from 'node:crypto';

import {
  PRODUCT_NAME,
  activeRunStatuses,
  getFastAgentParentFromPayload,
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputQuestion,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  db,
  type SlackInstallation,
  getTableColumns,
  inArray,
  isNull,
  slackInstallations,
  slackUserMappings,
  taskRuns,
  setTrustedRunActingUser,
  setTrustedRunActingUserOnSuccess,
  and,
  eq,
} from '@roomote/db/server';

import type { SlackInteractivePayload } from './types';
import { queueSlackMessage } from './slack-messages';
import { findActiveSlackTaskRun } from './find-active-slack-task-run';
import {
  postSlackAccountLinkThreadReply,
  promptSlackAccountLink,
} from './account-link';
import { postSlackInteractiveResponse } from './interactive-response';
import { SlackNotifier } from './slack-notifier';
import {
  buildSlackAnsweredRequestUserInputBlocks,
  buildSlackRequestUserInputBlocks,
  getSlackRequestUserInputCurrentQuestion,
} from './request-user-input-blocks';
import {
  advancePendingSlackRequestUserInputQuestion,
  clearPendingSlackRequestUserInput,
  getPendingSlackRequestUserInput,
  setPendingSlackRequestUserInputPromptMessageTs,
  submitPendingSlackRequestUserInputAnswer,
  type PendingSlackRequestUserInput,
} from './request-user-input';
import { getSlackThreadFooterText } from './thread-footer';

interface StructuredRequestUserInputButtonValue {
  requestId: string;
  questionId?: string;
  questionIndex?: number;
  answer?: string;
  cancel?: boolean;
}

const REQUEST_USER_INPUT_ALREADY_RECEIVED_TEXT =
  'I already received your answer. Please wait for the agent to continue.';

function buildSlackRequestUserInputTaskUrl(params: {
  taskId: string | null | undefined;
  payload?: unknown;
}): string {
  const origin = Env.R_APP_URL;
  const payload =
    params.payload && typeof params.payload === 'object'
      ? (params.payload as { webPath?: unknown })
      : null;
  const webPath =
    typeof payload?.webPath === 'string' && payload.webPath.startsWith('/')
      ? payload.webPath
      : null;
  const baseUrl =
    webPath || params.taskId
      ? `${origin}${webPath ?? `/task/${params.taskId}`}`
      : `${origin}/task`;
  const url = new URL(baseUrl);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'integration');
  url.searchParams.set('utm_campaign', 'request_user_input');

  return url.toString();
}

async function postRequestUserInputAlreadyReceivedResponse(
  responseUrl: string,
): Promise<void> {
  await postSlackInteractiveResponse(responseUrl, {
    replace_original: false,
    text: REQUEST_USER_INPUT_ALREADY_RECEIVED_TEXT,
  });
}

function parseStructuredRequestUserInputButtonValue(
  value: string,
): StructuredRequestUserInputButtonValue | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;

    if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0) {
      return null;
    }

    if (parsed.cancel === true) {
      return {
        requestId: parsed.requestId,
        questionIndex:
          typeof parsed.questionIndex === 'number' ? parsed.questionIndex : 0,
        cancel: true,
      };
    }

    if (
      typeof parsed.questionId === 'string' &&
      parsed.questionId.length > 0 &&
      typeof parsed.answer === 'string' &&
      parsed.answer.length > 0
    ) {
      return {
        requestId: parsed.requestId,
        questionId: parsed.questionId,
        questionIndex:
          typeof parsed.questionIndex === 'number' ? parsed.questionIndex : 0,
        answer: parsed.answer,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Fast children are deliberately unbound from tasks.slackThreadTs, so
 * findActiveSlackTaskRun cannot see them. When this thread holds a pending
 * structured prompt whose requestId matches the clicked button, resolve the
 * child run directly from that prompt's run ID and verify the run's
 * fastAgentParent stamp points back at this exact thread and workspace.
 */
async function findFastAgentChildRunForPendingInput(params: {
  threadId: string;
  slackTeamId: string;
  answerValue: string;
}) {
  const structuredAnswer = parseStructuredRequestUserInputButtonValue(
    params.answerValue,
  );
  if (!structuredAnswer) {
    return null;
  }

  const pendingRequest = await getPendingSlackRequestUserInput(params.threadId);
  if (
    !pendingRequest ||
    pendingRequest.requestId !== structuredAnswer.requestId
  ) {
    return null;
  }

  const [run] = await db
    .select(getTableColumns(taskRuns))
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.id, pendingRequest.runId),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);
  if (!run) {
    return null;
  }

  const parent = getFastAgentParentFromPayload(run.payload);
  if (
    !parent ||
    parent.conversation.surface !== 'slack' ||
    parent.conversation.workspaceId !== params.slackTeamId ||
    parent.conversation.replyTarget.threadId !== params.threadId
  ) {
    return null;
  }

  return run;
}

function mergeRequestUserInputAnswers(
  existing: AcpRequestUserInputAnswers,
  next: AcpRequestUserInputAnswers,
): AcpRequestUserInputAnswers {
  return {
    ...existing,
    ...next,
  };
}

function buildRequestUserInputPromptClientMessageId(
  requestId: string,
  questionIndex: number,
): string {
  const digest = createHash('sha256')
    .update(`${requestId}:${questionIndex}`)
    .digest('hex');

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function deliverPendingSlackRequestUserInputQuestion(params: {
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  request: PendingSlackRequestUserInput;
  previousQuestion: AcpRequestUserInputQuestion;
  previousAnswer: string;
  taskUrl: string;
}): Promise<void> {
  const nextPromptMessageTs = await params.slack.postMessage({
    channel: params.channel,
    thread_ts: params.threadId,
    client_msg_id: buildRequestUserInputPromptClientMessageId(
      params.request.requestId,
      params.request.currentQuestionIndex,
    ),
    blocks: buildSlackRequestUserInputBlocks({
      requestId: params.request.requestId,
      questions: params.request.questions,
      currentQuestionIndex: params.request.currentQuestionIndex,
      answers: params.request.answers,
      footerText: await getSlackThreadFooterText({
        taskUrl: params.taskUrl,
        taskId: params.request.taskId,
        prRepo: null,
        prNumber: null,
        channelId: params.channel,
        threadTs: params.threadId,
      }),
    }),
  });

  if (!nextPromptMessageTs) {
    throw new Error(
      'Your answer was saved, but I could not show the next question. Please try your answer again.',
    );
  }

  if (params.request.promptMessageTs) {
    await params.slack
      .updateMessage({
        channel: params.channel,
        ts: params.request.promptMessageTs,
        message: {
          blocks: buildSlackAnsweredRequestUserInputBlocks({
            question: params.previousQuestion,
            answer: params.previousAnswer,
          }),
        },
      })
      .catch((error) => {
        console.error(
          `Failed to update answered Slack request_user_input prompt: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  await setPendingSlackRequestUserInputPromptMessageTs(
    params.threadId,
    params.request.requestId,
    params.request.currentQuestionIndex,
    nextPromptMessageTs,
  );
}

async function getSlackTeamContext(teamId: string): Promise<{
  slack: SlackNotifier;
  slackInstallation: SlackInstallation;
}> {
  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!slackInstallation) {
    throw new Error('Slack installation not found');
  }

  return {
    slack: new SlackNotifier(slackInstallation.botAccessToken),
    slackInstallation,
  };
}

export async function handleFollowupAnswer(payload: SlackInteractivePayload) {
  try {
    const threadId = payload.message.thread_ts || payload.message.ts;

    const answerValue =
      payload.actions[0]?.type === 'button'
        ? payload.actions[0].value
        : undefined;

    if (!answerValue) {
      console.error('❌ No answer found in followup button payload');
      return;
    }

    const activeRun =
      (await findActiveSlackTaskRun(threadId, {
        slackTeamId: payload.team.id,
      })) ??
      (await findFastAgentChildRunForPendingInput({
        threadId,
        slackTeamId: payload.team.id,
        answerValue,
      }));

    if (!activeRun) {
      console.error(
        `❌ No active task run found for thread ${threadId} to send followup answer`,
      );

      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: false,
        text: 'This task is no longer active. Please ask the agent again in the thread.',
      });
      return;
    }

    const [userMapping] = await db
      .select({ userId: slackUserMappings.userId })
      .from(slackUserMappings)
      .where(
        and(
          eq(slackUserMappings.slackUserId, payload.user.id),
          eq(slackUserMappings.slackTeamId, payload.team.id),
        ),
      )
      .limit(1);

    if (!userMapping) {
      const { slack, slackInstallation } = await getSlackTeamContext(
        payload.team.id,
      );

      const promptResult = await promptSlackAccountLink({
        slackUserId: payload.user.id,
        channel: payload.channel.id,
        threadTs: threadId,
        originalText: answerValue,
        slackInstallation,
        slack,
        resumeOriginalThread: false,
      });

      await postSlackAccountLinkThreadReply({
        slack,
        channel: payload.channel.id,
        threadTs: threadId,
        slackUserId: payload.user.id,
        dmPromptSent: promptResult.dmPromptSent,
      });

      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: false,
        text: `Please link your ${PRODUCT_NAME} account before using this button.`,
      });

      return;
    }

    console.log(
      `✅ Queueing followup answer for job ${activeRun.id}: "${answerValue}"`,
    );

    const structuredAnswer =
      parseStructuredRequestUserInputButtonValue(answerValue);

    if (structuredAnswer) {
      const pendingRequest = await getPendingSlackRequestUserInput(threadId);

      if (
        !pendingRequest ||
        pendingRequest.requestId !== structuredAnswer.requestId
      ) {
        throw new Error(
          'This question is no longer pending. Please ask the agent again.',
        );
      }

      if (pendingRequest.status !== 'pending') {
        await postRequestUserInputAlreadyReceivedResponse(payload.response_url);
        return;
      }

      if (pendingRequest.runId !== activeRun.id) {
        await clearPendingSlackRequestUserInput(threadId, {
          requestId: pendingRequest.requestId,
        }).catch(() => {});

        throw new Error(
          'This question belongs to an older task. Please ask the agent again.',
        );
      }

      const { slack } = await getSlackTeamContext(payload.team.id);
      const currentQuestion =
        getSlackRequestUserInputCurrentQuestion(pendingRequest);

      if (!currentQuestion) {
        throw new Error(
          'This question is no longer available. Please ask the agent again.',
        );
      }

      const previousQuestionIndex = currentQuestion.questionIndex - 1;
      const previousQuestion = pendingRequest.questions[previousQuestionIndex];
      const previousAnswers = structuredAnswer.questionId
        ? pendingRequest.answers[structuredAnswer.questionId]?.answers
        : undefined;
      const isPendingDeliveryRetry =
        previousQuestionIndex >= 0 &&
        structuredAnswer.questionIndex === previousQuestionIndex &&
        structuredAnswer.questionId === previousQuestion?.id &&
        previousAnswers?.length === 1 &&
        previousAnswers[0] === structuredAnswer.answer;

      if (isPendingDeliveryRetry) {
        if (
          pendingRequest.promptMessageTs &&
          pendingRequest.promptMessageTs !== payload.message.ts
        ) {
          await postRequestUserInputAlreadyReceivedResponse(
            payload.response_url,
          );
          return;
        }

        await deliverPendingSlackRequestUserInputQuestion({
          slack,
          channel: payload.channel.id,
          threadId,
          request: pendingRequest,
          previousQuestion: previousQuestion!,
          previousAnswer: structuredAnswer.answer!,
          taskUrl: buildSlackRequestUserInputTaskUrl({
            taskId: activeRun.taskId,
            payload: activeRun.payload,
          }),
        });
        return;
      }

      if (
        structuredAnswer.questionIndex !== undefined &&
        structuredAnswer.questionIndex !== currentQuestion.questionIndex
      ) {
        throw new Error(
          'This prompt is out of date. Please answer the newest question in the thread.',
        );
      }

      if (structuredAnswer.cancel) {
        const submitted = await setTrustedRunActingUserOnSuccess({
          runId: activeRun.id,
          userId: userMapping.userId,
          operation: async () =>
            await submitPendingSlackRequestUserInputAnswer(
              threadId,
              pendingRequest,
              {
                answers: {},
                user: payload.user.id,
                userId: userMapping.userId,
                ts: new Date().toISOString(),
              },
            ),
        });

        if (!submitted) {
          await postRequestUserInputAlreadyReceivedResponse(
            payload.response_url,
          );
          return;
        }

        await slack.postMessage({
          channel: payload.channel.id,
          thread_ts: threadId,
          blocks: [
            {
              type: 'markdown',
              text: '**Cancelled the question.**',
            },
          ],
        });

        return;
      }

      if (structuredAnswer.questionId !== currentQuestion.question.id) {
        throw new Error(
          'This prompt is out of date. Please answer the newest question in the thread.',
        );
      }

      const nextAnswers = mergeRequestUserInputAnswers(pendingRequest.answers, {
        [structuredAnswer.questionId]: {
          answers: [structuredAnswer.answer!],
        },
      });
      const nextQuestionIndex = currentQuestion.questionIndex + 1;

      if (nextQuestionIndex >= pendingRequest.questions.length) {
        const submitted = await setTrustedRunActingUserOnSuccess({
          runId: activeRun.id,
          userId: userMapping.userId,
          operation: async () =>
            await submitPendingSlackRequestUserInputAnswer(
              threadId,
              pendingRequest,
              {
                answers: nextAnswers,
                user: payload.user.id,
                userId: userMapping.userId,
                ts: new Date().toISOString(),
              },
            ),
        });

        if (!submitted) {
          await postRequestUserInputAlreadyReceivedResponse(
            payload.response_url,
          );
          return;
        }

        if (pendingRequest.promptMessageTs) {
          await slack.updateMessage({
            channel: payload.channel.id,
            ts: pendingRequest.promptMessageTs,
            message: {
              blocks: buildSlackAnsweredRequestUserInputBlocks({
                question: currentQuestion.question,
                answer: structuredAnswer.answer!,
              }),
            },
          });
        }

        return;
      }

      const advanced = await advancePendingSlackRequestUserInputQuestion(
        threadId,
        pendingRequest,
        nextQuestionIndex,
        nextAnswers,
      );

      if (!advanced) {
        await postRequestUserInputAlreadyReceivedResponse(payload.response_url);
        return;
      }

      await deliverPendingSlackRequestUserInputQuestion({
        slack,
        channel: payload.channel.id,
        threadId,
        request: {
          ...pendingRequest,
          currentQuestionIndex: nextQuestionIndex,
          answers: nextAnswers,
        },
        previousQuestion: currentQuestion.question,
        previousAnswer: structuredAnswer.answer!,
        taskUrl: buildSlackRequestUserInputTaskUrl({
          taskId: activeRun.taskId,
          payload: activeRun.payload,
        }),
      });

      return;
    }

    await setTrustedRunActingUser({
      runId: activeRun.id,
      userId: userMapping.userId,
    });
    await queueSlackMessage(activeRun.id, {
      text: answerValue,
      user: payload.user.id,
      userId: userMapping.userId,
      ts: new Date().toISOString(),
    });

    const { slack } = await getSlackTeamContext(payload.team.id);

    await slack.postMessage({
      channel: payload.channel.id,
      thread_ts: threadId,
      blocks: [
        {
          type: 'markdown',
          text: `**Selected:** ${answerValue}`,
        },
      ],
    });
  } catch (error) {
    console.error(
      `❌ Failed to handle followup answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: `❌ Failed to process answer: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

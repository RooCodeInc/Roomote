import { sdk } from '@roomote/sdk/client';
import {
  stripLeadingSlackProductMention,
  wrapSlackMessage,
} from '@roomote/cloud-agents';
import {
  prependSlackMessages,
  prependSlackRequestUserInputAnswers,
} from '@roomote/slack/client';

import { recordChatTurnStart } from '../../mcp/roomote-mcp-server/chat-reply-satisfaction';
import { isActiveTaskPhase } from '../../sandbox-server/lib/harness-manager';
import type { ListenerOptions } from '../types';
import {
  logPollingTransportError,
  runPollingSdkCall,
} from './poll-error-context';

/** Interval (ms) between polling for new Slack messages during SlackAppMention tasks. */
const SLACK_MESSAGE_CHECK_INTERVAL_MS = 5_000;

type QueuedSlackMessages = Awaited<
  ReturnType<typeof sdk.cloudJobs.getSlackMessages>
>;

function getSlackClientMessageId(message: QueuedSlackMessages[number]): string {
  return `slack:${message.ts}`;
}

async function requeueSlackRequestUserInputAnswers(
  cloudJobId: number,
  queuedAnswers: Awaited<
    ReturnType<typeof sdk.cloudJobs.getSlackRequestUserInputAnswers>
  >,
  startIndex: number,
): Promise<void> {
  await prependSlackRequestUserInputAnswers(
    cloudJobId,
    queuedAnswers.slice(startIndex),
  );
}

async function requeueSlackMessages(
  cloudJobId: number,
  deliveryOrder: QueuedSlackMessages,
  startIndex: number,
): Promise<void> {
  const remainingQueueOrder = [...deliveryOrder.slice(startIndex)].reverse();
  await prependSlackMessages(cloudJobId, remainingQueueOrder);
}

function getQueuedSlackTurnReactionAllowance(
  message: QueuedSlackMessages[number],
): boolean | undefined {
  return message.turnPolicy?.reactionsAllowed;
}

export function createSlackMessageInterval({
  cloudJob,
  sendPrompt,
  slackReplySatisfactionStateFile,
  answerUserInputRequest,
  state,
  logger,
  prepareActorScopedTurn,
}: ListenerOptions): NodeJS.Timeout {
  let stopping = false;
  let activePoll = Promise.resolve();

  state.slackMessageCleanup = async () => {
    stopping = true;
    await activePoll;
  };

  const pollOnce = async () => {
    if (stopping || !state.sessionId) {
      return;
    }

    try {
      const queuedAnswers = await runPollingSdkCall({
        execute: () =>
          sdk.cloudJobs.getSlackRequestUserInputAnswers({
            cloudJobId: cloudJob.id,
          }),
        stage: 'listenForSlackEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'cloudJobs.getSlackRequestUserInputAnswers',
        failurePoint: 'queuedSlackRequestUserInputAnswers',
        logger,
        message: `[listenForSlackEvents] Failed to check for queued Slack request_user_input answers for job ${cloudJob.id}`,
      });

      if (!queuedAnswers) {
        return;
      }

      if (queuedAnswers.length > 0) {
        logger.log(
          `[listenForSlackEvents] Found ${queuedAnswers.length} queued Slack request_user_input answer(s) for job ${cloudJob.id}`,
        );

        for (const [index, answer] of queuedAnswers.entries()) {
          // Polled answers have no trusted per-message actor write; deliver
          // under the server actor rather than stalling the queue.
          const answerPrep = await prepareActorScopedTurn(answer.userId, {
            onMismatch: 'follow-server',
          });

          if (answerPrep === false) {
            logger.warn(
              `[listenForSlackEvents] Delaying request_user_input answer for task ${state.sessionId} until actor-scoped turn preparation succeeds (requestId=${answer.requestId})`,
            );

            try {
              await requeueSlackRequestUserInputAnswers(
                cloudJob.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue delayed request_user_input answer for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }

          const sent = answerUserInputRequest({
            requestId: answer.requestId,
            answers: answer.answers,
            // Attribute the turn to the identity actor-scoped routes resolve.
            userId: answerPrep.effectiveUserId ?? undefined,
          });

          logger.log(
            `[listenForSlackEvents] answerUserInputRequest returned ${sent} for task ${state.sessionId} (requestId=${answer.requestId})`,
          );

          if (!sent) {
            logger.warn(
              `[listenForSlackEvents] Failed to send request_user_input answer for task ${state.sessionId}; requeueing requestId=${answer.requestId}`,
            );

            try {
              await requeueSlackRequestUserInputAnswers(
                cloudJob.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue request_user_input answer for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }
        }
      }

      const slackMessages = await runPollingSdkCall({
        execute: () =>
          sdk.cloudJobs.getSlackMessages({
            cloudJobId: cloudJob.id,
          }),
        stage: 'listenForSlackEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'cloudJobs.getSlackMessages',
        failurePoint: 'queuedSlackMessages',
        logger,
        message: `[listenForSlackEvents] Failed to check for queued Slack messages for job ${cloudJob.id}`,
      });

      if (!slackMessages) {
        return;
      }

      if (slackMessages.length > 0) {
        logger.log(
          `[listenForSlackEvents] Found ${slackMessages.length} queued Slack message(s) for job ${cloudJob.id}`,
        );

        const deliveryOrder = [...slackMessages].reverse();
        let index = 0;

        while (index < deliveryOrder.length) {
          const msg = deliveryOrder[index]!;

          logger.log(
            `[listenForSlackEvents] Sending Slack message to task ${state.sessionId}: ${msg.text.substring(0, 100)}`,
          );

          const allowMcpReconnect =
            !state.phase ||
            !isActiveTaskPhase(state.phase) ||
            state.isConnected === false;

          // The API performs a trusted pre-queue actor sync for these
          // messages; a residual mismatch (e.g. two senders racing the poll)
          // delivers under the server actor rather than stalling the queue.
          const msgPrep = await prepareActorScopedTurn(msg.userId, {
            allowMcpReconnect,
            onMismatch: 'follow-server',
          });

          if (msgPrep === false) {
            logger.warn(
              `[listenForSlackEvents] Delaying Slack follow-up for task ${state.sessionId} until actor-scoped turn preparation succeeds`,
            );

            try {
              await requeueSlackMessages(cloudJob.id, deliveryOrder, index);
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue delayed Slack message for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            break;
          }

          const prompt =
            msg.formattedPrompt ??
            wrapSlackMessage(stripLeadingSlackProductMention(msg.text), {
              ts: msg.ts,
            });
          const sent = sendPrompt({
            prompt,
            images: msg.images,
            autoSteerWhenQueued: true,
            source: 'slack',
            // Attribute the turn to the identity actor-scoped routes resolve.
            userId: msgPrep.effectiveUserId ?? undefined,
            clientMessageId: getSlackClientMessageId(msg),
          });

          logger.log(
            `[listenForSlackEvents] sendPrompt returned ${sent} for task ${state.sessionId} (prompt length=${prompt.length}, images=${msg.images?.length ?? 0})`,
          );

          if (!sent) {
            logger.warn(
              `[listenForSlackEvents] Failed to send follow-up prompt for task ${state.sessionId}`,
            );

            try {
              await requeueSlackMessages(cloudJob.id, deliveryOrder, index);
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue Slack follow-up for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }

          recordChatTurnStart({
            turnMessageTs: msg.ts,
            allowReaction: getQueuedSlackTurnReactionAllowance(msg),
            sessionId: state.sessionId,
            stateFilePath: slackReplySatisfactionStateFile,
          });

          index += 1;
        }
      }
    } catch (error) {
      logPollingTransportError({
        stage: 'listenForSlackEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'listenForSlackEvents.delivery',
        failurePoint: 'queuedSlackDelivery',
        logger,
        error,
        message: `[listenForSlackEvents] Unexpected error while delivering queued Slack events for job ${cloudJob.id}`,
      });
    }
  };

  const interval = setInterval(() => {
    activePoll = activePoll.then(async () => {
      await pollOnce();
    });
  }, SLACK_MESSAGE_CHECK_INTERVAL_MS);

  return interval;
}

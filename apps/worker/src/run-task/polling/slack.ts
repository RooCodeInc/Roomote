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
import { createDiagnosticEventRecorder } from '../diagnostic-events';
import type { ListenerOptions } from '../types';
import {
  logPollingTransportError,
  runPollingSdkCall,
} from './poll-error-context';
import { createSerializedPollLoop } from './serialized-poll-loop';

/** Interval (ms) between polling for new Slack messages during SlackAppMention tasks. */
const SLACK_MESSAGE_CHECK_INTERVAL_MS = 5_000;

type QueuedSlackMessages = Awaited<
  ReturnType<typeof sdk.taskRuns.getSlackMessages>
>;

function getSlackClientMessageId(message: QueuedSlackMessages[number]): string {
  return `slack:${message.ts}`;
}

async function requeueSlackRequestUserInputAnswers(
  runId: number,
  queuedAnswers: Awaited<
    ReturnType<typeof sdk.taskRuns.getSlackRequestUserInputAnswers>
  >,
  startIndex: number,
): Promise<void> {
  await prependSlackRequestUserInputAnswers(
    runId,
    queuedAnswers.slice(startIndex),
  );
}

async function requeueSlackMessages(
  runId: number,
  deliveryOrder: QueuedSlackMessages,
  startIndex: number,
): Promise<void> {
  const remainingQueueOrder = [...deliveryOrder.slice(startIndex)].reverse();
  await prependSlackMessages(runId, remainingQueueOrder);
}

function getQueuedSlackTurnReactionAllowance(
  message: QueuedSlackMessages[number],
): boolean | undefined {
  return message.turnPolicy?.reactionsAllowed;
}

export function createSlackMessageInterval({
  taskRun,
  sendPrompt,
  slackReplySatisfactionStateFile,
  answerUserInputRequest,
  state,
  logger,
  prepareActorScopedTurn,
}: ListenerOptions): NodeJS.Timeout {
  const diagnostics = createDiagnosticEventRecorder({
    runId: taskRun.id,
    logger,
  });

  const pollOnce = async () => {
    if (!state.sessionId) {
      return;
    }

    try {
      const queuedAnswers = await runPollingSdkCall({
        execute: () =>
          sdk.taskRuns.getSlackRequestUserInputAnswers({
            runId: taskRun.id,
          }),
        stage: 'listenForSlackEvents',
        runId: taskRun.id,
        sessionId: state.sessionId,
        sdkMethod: 'taskRuns.getSlackRequestUserInputAnswers',
        failurePoint: 'queuedSlackRequestUserInputAnswers',
        logger,
        message: `[listenForSlackEvents] Failed to check for queued Slack request_user_input answers for job ${taskRun.id}`,
      });

      if (!queuedAnswers) {
        return;
      }

      if (queuedAnswers.length > 0) {
        logger.log(
          `[listenForSlackEvents] Found ${queuedAnswers.length} queued Slack request_user_input answer(s) for job ${taskRun.id}`,
        );

        for (const [index, answer] of queuedAnswers.entries()) {
          // The API atomically couples the winning answer claim to its
          // trusted actor write. If the worker drains Redis just before that
          // DB transaction commits, block and requeue instead of dropping an
          // answer that is already marked submitted and cannot be resent.
          const answerPrep = await prepareActorScopedTurn(answer.userId);

          if (answerPrep === false || answerPrep.skippedMismatch) {
            logger.warn(
              `[listenForSlackEvents] Delaying request_user_input answer for task ${state.sessionId} until actor-scoped turn preparation succeeds (requestId=${answer.requestId})`,
            );

            try {
              await requeueSlackRequestUserInputAnswers(
                taskRun.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue delayed request_user_input answer for task run ${taskRun.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }

          const sent = answerUserInputRequest({
            requestId: answer.requestId,
            answers: answer.answers,
            // The delivered sender always equals the server-side acting user.
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
                taskRun.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue request_user_input answer for task run ${taskRun.id}: ${
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
          sdk.taskRuns.getSlackMessages({
            runId: taskRun.id,
          }),
        stage: 'listenForSlackEvents',
        runId: taskRun.id,
        sessionId: state.sessionId,
        sdkMethod: 'taskRuns.getSlackMessages',
        failurePoint: 'queuedSlackMessages',
        logger,
        message: `[listenForSlackEvents] Failed to check for queued Slack messages for job ${taskRun.id}`,
      });

      if (!slackMessages) {
        return;
      }

      if (slackMessages.length > 0) {
        logger.log(
          `[listenForSlackEvents] Found ${slackMessages.length} queued Slack message(s) for job ${taskRun.id}`,
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
          // skips that message's content (with a resend notice) rather than
          // running it under the server actor or stalling the queue.
          const msgPrep = await prepareActorScopedTurn(msg.userId, {
            allowMcpReconnect,
            onMismatch: 'skip',
          });

          if (msgPrep === false) {
            logger.warn(
              `[listenForSlackEvents] Delaying Slack follow-up for task ${state.sessionId} until actor-scoped turn preparation succeeds`,
            );
            diagnostics.record({
              kind: 'queued_message_requeued',
              message: `Requeued ${deliveryOrder.length - index} queued Slack message(s) because actor-scoped turn preparation did not succeed.`,
              details: {
                provider: 'slack',
                reason: 'actor_prep_failed',
                count: deliveryOrder.length - index,
                ts: msg.ts,
              },
            });

            try {
              await requeueSlackMessages(taskRun.id, deliveryOrder, index);
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue delayed Slack message for task run ${taskRun.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            break;
          }

          if (msgPrep.skippedMismatch) {
            logger.warn(
              `[listenForSlackEvents] Skipped Slack follow-up for task ${state.sessionId}: sender is not the server-side acting user (ts=${msg.ts})`,
            );
            diagnostics.record({
              kind: 'queued_message_skipped',
              message: `Skipped queued Slack message ts=${msg.ts}: sender is not the server-side acting user.`,
              details: {
                provider: 'slack',
                reason: 'actor_mismatch',
                ts: msg.ts,
              },
            });
            index += 1;
            continue;
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
            // The delivered sender always equals the server-side acting user.
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
            diagnostics.record({
              kind: 'queued_message_requeued',
              message: `Requeued ${deliveryOrder.length - index} queued Slack message(s) because the harness rejected the prompt.`,
              details: {
                provider: 'slack',
                reason: 'send_failed',
                count: deliveryOrder.length - index,
                ts: msg.ts,
              },
            });

            try {
              await requeueSlackMessages(taskRun.id, deliveryOrder, index);
            } catch (error) {
              logger.error(
                `[listenForSlackEvents] Failed to requeue Slack follow-up for task run ${taskRun.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }

          diagnostics.record({
            kind: 'queued_message_delivered',
            message: `Delivered queued Slack message ts=${msg.ts} to the harness.`,
            details: {
              provider: 'slack',
              ts: msg.ts,
              clientMessageId: getSlackClientMessageId(msg),
              promptLength: prompt.length,
            },
          });

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
        runId: taskRun.id,
        sessionId: state.sessionId,
        sdkMethod: 'listenForSlackEvents.delivery',
        failurePoint: 'queuedSlackDelivery',
        logger,
        error,
        message: `[listenForSlackEvents] Unexpected error while delivering queued Slack events for job ${taskRun.id}`,
      });
    }
  };

  const { interval, cleanup } = createSerializedPollLoop({
    pollOnce,
    intervalMs: SLACK_MESSAGE_CHECK_INTERVAL_MS,
    onStall: ({ stalledForMs }) => {
      logPollingTransportError({
        stage: 'listenForSlackEvents',
        runId: taskRun.id,
        sessionId: state.sessionId ?? '',
        sdkMethod: 'listenForSlackEvents.pollOnce',
        failurePoint: 'queuedSlackPollStalled',
        logger,
        error: new Error(
          `Slack queued-message poll stalled for ${stalledForMs}ms`,
        ),
        message: `[listenForSlackEvents] Queued Slack message poll for job ${taskRun.id} stalled for ${stalledForMs}ms; abandoning it and starting a fresh poll`,
      });
      diagnostics.record({
        kind: 'message_poller_stalled',
        message: `Queued Slack message poll stalled for ${stalledForMs}ms and was abandoned; a fresh poll took over.`,
        details: { provider: 'slack', stalledForMs },
      });
    },
    onStallRecovered: ({ ranForMs }) => {
      logger.warn(
        `[listenForSlackEvents] A previously stalled Slack poll for job ${taskRun.id} settled after ${ranForMs}ms`,
      );
      diagnostics.record({
        kind: 'message_poller_stall_recovered',
        message: `A previously stalled Slack poll settled after ${ranForMs}ms.`,
        details: { provider: 'slack', ranForMs },
      });
    },
  });

  state.slackMessageCleanup = cleanup;

  return interval;
}

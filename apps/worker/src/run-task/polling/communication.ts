import { prependCommunicationMessages } from '@roomote/communication/messages';
import { prependCommunicationRequestUserInputAnswers } from '@roomote/communication/request-user-input';
import type {
  CommunicationProvider,
  QueuedCommunicationMessage,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

import { isActiveTaskPhase } from '../../sandbox-server/lib/harness-manager';
import { recordChatTurnStart } from '../../mcp/roomote-mcp-server/chat-reply-satisfaction';
import type { ListenerOptions } from '../types';
import {
  logPollingTransportError,
  runPollingSdkCall,
} from './poll-error-context';
import { wrapCommunicationMessage } from '../communication-message-prompt';

const COMMUNICATION_MESSAGE_CHECK_INTERVAL_MS = 5_000;

function getCommunicationClientMessageId(
  provider: CommunicationProvider,
  message: QueuedCommunicationMessage,
): string {
  return `${provider}:${message.ts}`;
}

async function requeueCommunicationMessages(
  provider: CommunicationProvider,
  runId: number,
  deliveryOrder: QueuedCommunicationMessage[],
  startIndex: number,
): Promise<void> {
  const remainingQueueOrder = [...deliveryOrder.slice(startIndex)].reverse();
  await prependCommunicationMessages(provider, runId, remainingQueueOrder);
}

async function requeueCommunicationRequestUserInputAnswers(
  provider: Exclude<CommunicationProvider, 'slack'>,
  runId: number,
  queuedAnswers: Awaited<
    ReturnType<typeof sdk.taskRuns.getCommunicationRequestUserInputAnswers>
  >,
  startIndex: number,
): Promise<void> {
  await prependCommunicationRequestUserInputAnswers(
    provider,
    runId,
    queuedAnswers.slice(startIndex),
  );
}

export function createCommunicationMessageInterval({
  provider,
  options,
}: {
  provider: Exclude<CommunicationProvider, 'slack'>;
  options: ListenerOptions;
}): NodeJS.Timeout {
  const {
    taskRun,
    sendPrompt,
    state,
    logger,
    prepareActorScopedTurn,
    answerUserInputRequest,
  } = options;
  let stopping = false;
  let activePoll = Promise.resolve();

  state.communicationMessageCleanups ??= {};
  state.communicationMessageCleanups[provider] = async () => {
    stopping = true;
    await activePoll;
  };

  const pollOnce = async () => {
    if (stopping || !state.sessionId) {
      return;
    }

    try {
      if (provider === 'discord') {
        const queuedAnswers = await runPollingSdkCall({
          execute: () =>
            sdk.taskRuns.getCommunicationRequestUserInputAnswers({
              runId: taskRun.id,
              provider,
            }),
          stage: `listenFor${provider}Events`,
          runId: taskRun.id,
          sessionId: state.sessionId,
          sdkMethod: 'taskRuns.getCommunicationRequestUserInputAnswers',
          failurePoint: 'queuedCommunicationRequestUserInputAnswers',
          logger,
          message: `[listenFor${provider}Events] Failed to check for queued ${provider} request_user_input answers for job ${taskRun.id}`,
        });

        if (!queuedAnswers) {
          return;
        }

        if (queuedAnswers.length > 0) {
          logger.log(
            `[listenFor${provider}Events] Found ${queuedAnswers.length} queued ${provider} request_user_input answer(s) for job ${taskRun.id}`,
          );

          for (const [index, answer] of queuedAnswers.entries()) {
            const answerPrep = await prepareActorScopedTurn(answer.userId);

            if (answerPrep === false || answerPrep.skippedMismatch) {
              logger.warn(
                `[listenFor${provider}Events] Delaying request_user_input answer for task ${state.sessionId} until actor-scoped turn preparation succeeds (requestId=${answer.requestId})`,
              );

              try {
                await requeueCommunicationRequestUserInputAnswers(
                  provider,
                  taskRun.id,
                  queuedAnswers,
                  index,
                );
              } catch (error) {
                logger.error(
                  `[listenFor${provider}Events] Failed to requeue delayed ${provider} request_user_input answer for task run ${taskRun.id}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }

              return;
            }

            const sent = answerUserInputRequest({
              requestId: answer.requestId,
              answers: answer.answers,
              userId: answerPrep.effectiveUserId ?? undefined,
            });

            logger.log(
              `[listenFor${provider}Events] answerUserInputRequest returned ${sent} for task ${state.sessionId} (requestId=${answer.requestId})`,
            );

            if (!sent) {
              logger.warn(
                `[listenFor${provider}Events] Failed to send request_user_input answer for task ${state.sessionId}; requeueing requestId=${answer.requestId}`,
              );

              try {
                await requeueCommunicationRequestUserInputAnswers(
                  provider,
                  taskRun.id,
                  queuedAnswers,
                  index,
                );
              } catch (error) {
                logger.error(
                  `[listenFor${provider}Events] Failed to requeue ${provider} request_user_input answer for task run ${taskRun.id}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }

              return;
            }
          }
        }
      }

      const messages = await runPollingSdkCall({
        execute: () =>
          sdk.taskRuns.getCommunicationMessages({
            runId: taskRun.id,
            provider,
          }),
        stage: `listenFor${provider}Events`,
        runId: taskRun.id,
        sessionId: state.sessionId,
        sdkMethod: 'taskRuns.getCommunicationMessages',
        failurePoint: 'queuedCommunicationMessages',
        logger,
        message: `[listenFor${provider}Events] Failed to check for queued ${provider} messages for job ${taskRun.id}`,
      });

      if (!messages?.length) {
        return;
      }

      logger.log(
        `[listenFor${provider}Events] Found ${messages.length} queued ${provider} message(s) for job ${taskRun.id}`,
      );

      const deliveryOrder = [...messages].reverse();
      let index = 0;

      while (index < deliveryOrder.length) {
        const message = deliveryOrder[index]!;
        const allowMcpReconnect =
          !state.phase ||
          !isActiveTaskPhase(state.phase) ||
          state.isConnected === false;

        // The API performs a trusted pre-queue actor sync for these
        // messages; a residual mismatch skips that message's content (with a
        // resend notice) rather than running it under the server actor or
        // stalling the queue.
        const msgPrep = await prepareActorScopedTurn(message.userId, {
          allowMcpReconnect,
          onMismatch: 'skip',
        });

        if (msgPrep === false) {
          logger.warn(
            `[listenFor${provider}Events] Delaying ${provider} follow-up for task ${state.sessionId} until actor-scoped turn preparation succeeds`,
          );

          try {
            await requeueCommunicationMessages(
              provider,
              taskRun.id,
              deliveryOrder,
              index,
            );
          } catch (error) {
            logger.error(
              `[listenFor${provider}Events] Failed to requeue delayed ${provider} message for task run ${taskRun.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          return;
        }

        if (msgPrep.skippedMismatch) {
          logger.warn(
            `[listenFor${provider}Events] Skipped ${provider} follow-up for task ${state.sessionId}: sender is not the server-side acting user (ts=${message.ts})`,
          );
          index += 1;
          continue;
        }

        const prompt =
          message.formattedPrompt ??
          wrapCommunicationMessage(provider, message);
        const sent = sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: provider,
          // The delivered sender always equals the server-side acting user.
          userId: msgPrep.effectiveUserId ?? undefined,
          clientMessageId: getCommunicationClientMessageId(provider, message),
        });

        if (!sent) {
          logger.warn(
            `[listenFor${provider}Events] Failed to send follow-up prompt for task ${state.sessionId}`,
          );

          try {
            await requeueCommunicationMessages(
              provider,
              taskRun.id,
              deliveryOrder,
              index,
            );
          } catch (error) {
            logger.error(
              `[listenFor${provider}Events] Failed to requeue ${provider} follow-up for task run ${taskRun.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          return;
        }

        if (
          provider === 'telegram' ||
          provider === 'teams' ||
          provider === 'discord'
        ) {
          // Telegram, Teams, and Discord turns feed the same satisfaction
          // machinery as Slack so ack/closeout enforcement and current-turn
          // reactions work.
          recordChatTurnStart({
            turnMessageTs: message.ts,
            allowReaction: message.turnPolicy?.reactionsAllowed,
            sessionId: state.sessionId,
            stateFilePath: options.slackReplySatisfactionStateFile,
          });
        }

        index += 1;
      }
    } catch (error) {
      logPollingTransportError({
        stage: `listenFor${provider}Events`,
        runId: taskRun.id,
        sessionId: state.sessionId,
        sdkMethod: 'listenForCommunicationEvents.delivery',
        failurePoint: 'queuedCommunicationDelivery',
        logger,
        error,
        message: `[listenFor${provider}Events] Unexpected error while delivering queued ${provider} events for job ${taskRun.id}`,
      });
    }
  };

  const interval = setInterval(() => {
    activePoll = activePoll.then(async () => {
      await pollOnce();
    });
  }, COMMUNICATION_MESSAGE_CHECK_INTERVAL_MS);

  return interval;
}

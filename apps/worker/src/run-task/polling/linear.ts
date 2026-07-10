import { sdk } from '@roomote/sdk/client';
import {
  prependLinearMessages,
  prependLinearRequestUserInputAnswers,
} from '@roomote/linear/client';

import { isActiveTaskPhase } from '../../sandbox-server/lib/harness-manager';
import type { ListenerOptions } from '../types';
import {
  logPollingTransportError,
  runPollingSdkCall,
} from './poll-error-context';

const LINEAR_MESSAGE_CHECK_INTERVAL_MS = 5_000;

async function requeueLinearRequestUserInputAnswers(
  cloudJobId: number,
  queuedAnswers: Awaited<
    ReturnType<typeof sdk.cloudJobs.getLinearRequestUserInputAnswers>
  >,
  startIndex: number,
): Promise<void> {
  await prependLinearRequestUserInputAnswers(
    cloudJobId,
    queuedAnswers.slice(startIndex),
  );
}

async function requeueLinearMessages(
  cloudJobId: number,
  linearMessages: Awaited<ReturnType<typeof sdk.cloudJobs.getLinearMessages>>,
  startIndex: number,
): Promise<void> {
  await prependLinearMessages(cloudJobId, linearMessages.slice(startIndex));
}

export function createLinearMessageInterval({
  cloudJob,
  sendPrompt,
  answerUserInputRequest,
  state,
  logger,
  prepareActorScopedTurn,
}: ListenerOptions): NodeJS.Timeout {
  return setInterval(async () => {
    if (!state.sessionId) {
      return;
    }

    try {
      const queuedAnswers = await runPollingSdkCall({
        execute: () =>
          sdk.cloudJobs.getLinearRequestUserInputAnswers({
            cloudJobId: cloudJob.id,
          }),
        stage: 'listenForLinearEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'cloudJobs.getLinearRequestUserInputAnswers',
        failurePoint: 'queuedLinearRequestUserInputAnswers',
        logger,
        message: `[listenForLinearEvents] Failed to check for queued Linear request_user_input answers for job ${cloudJob.id}`,
      });

      if (!queuedAnswers) {
        return;
      }

      if (queuedAnswers.length > 0) {
        logger.log(
          `[listenForLinearEvents] Found ${queuedAnswers.length} queued Linear request_user_input answer(s) for job ${cloudJob.id}`,
        );

        for (const [index, answer] of queuedAnswers.entries()) {
          // The API couples answer queueing to its trusted actor write. If the
          // worker drains Redis just before that DB transaction commits,
          // block and requeue instead of dropping an answer that is already
          // marked submitted and cannot be resent.
          const answerPrep = await prepareActorScopedTurn(answer.userId);

          if (answerPrep === false || answerPrep.skippedMismatch) {
            logger.warn(
              `[listenForLinearEvents] Delaying request_user_input answer for task ${state.sessionId} until actor-scoped turn preparation succeeds (requestId=${answer.requestId})`,
            );

            try {
              await requeueLinearRequestUserInputAnswers(
                cloudJob.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForLinearEvents] Failed to requeue delayed request_user_input answer for cloud job ${cloudJob.id}: ${
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

          if (!sent) {
            logger.warn(
              `[listenForLinearEvents] Failed to send request_user_input answer for task ${state.sessionId}; requeueing requestId=${answer.requestId}`,
            );

            try {
              await requeueLinearRequestUserInputAnswers(
                cloudJob.id,
                queuedAnswers,
                index,
              );
            } catch (error) {
              logger.error(
                `[listenForLinearEvents] Failed to requeue request_user_input answer for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            return;
          }

          logger.log(
            `[listenForLinearEvents] Sent request_user_input answer for task ${state.sessionId} (requestId=${answer.requestId}, sent=${sent})`,
          );
        }
      }

      const linearMessages = await runPollingSdkCall({
        execute: () =>
          sdk.cloudJobs.getLinearMessages({
            cloudJobId: cloudJob.id,
          }),
        stage: 'listenForLinearEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'cloudJobs.getLinearMessages',
        failurePoint: 'queuedLinearMessages',
        logger,
        message: `[listenForLinearEvents] Failed to check for queued Linear messages for job ${cloudJob.id}`,
      });

      if (!linearMessages) {
        return;
      }

      if (linearMessages.length > 0) {
        logger.log(
          `[listenForLinearEvents] Found ${linearMessages.length} queued Linear message(s) for job ${cloudJob.id}`,
        );

        for (const [index, msg] of linearMessages.entries()) {
          const text =
            msg.action === 'prompted' &&
            msg.payload.agentActivity?.content?.body
              ? msg.payload.agentActivity.content.body
              : msg.payload.agentSession.issue.description || '';

          logger.log(
            `[listenForLinearEvents] Sending Linear message to task ${state.sessionId}: ${text.substring(0, 100)}`,
          );

          const allowMcpReconnect =
            !state.phase ||
            !isActiveTaskPhase(state.phase) ||
            state.isConnected === false;

          // The API performs a trusted pre-queue actor sync for these
          // messages; a residual mismatch skips that message's content (with
          // a resend notice) rather than running it under the server actor
          // or stalling the queue.
          const msgPrep = await prepareActorScopedTurn(msg.userId, {
            allowMcpReconnect,
            onMismatch: 'skip',
          });

          if (msgPrep === false) {
            logger.warn(
              `[listenForLinearEvents] Delaying Linear follow-up for task ${state.sessionId} until actor-scoped turn preparation succeeds`,
            );

            try {
              await requeueLinearMessages(cloudJob.id, linearMessages, index);
            } catch (error) {
              logger.error(
                `[listenForLinearEvents] Failed to requeue delayed Linear message for cloud job ${cloudJob.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            break;
          }

          if (msgPrep.skippedMismatch) {
            logger.warn(
              `[listenForLinearEvents] Skipped Linear follow-up for task ${state.sessionId}: sender is not the server-side acting user`,
            );
            continue;
          }

          const sent = sendPrompt({
            prompt: text,
            source: 'linear',
            // Deliver mid-turn replies like Slack does: native injection when
            // the loop can pick them up, abort-and-replay when the turn is
            // blocked on a pending question tool call.
            autoSteerWhenQueued: true,
            // The delivered sender always equals the server-side acting user.
            userId: msgPrep.effectiveUserId ?? undefined,
          });

          if (!sent) {
            logger.warn(
              `[listenForLinearEvents] Failed to send follow-up prompt for task ${state.sessionId}`,
            );
          }

          logger.log(
            `[listenForLinearEvents] Sent follow-up message to task ${state.sessionId}`,
          );
        }
      }
    } catch (error) {
      logPollingTransportError({
        stage: 'listenForLinearEvents',
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'listenForLinearEvents.delivery',
        failurePoint: 'queuedLinearDelivery',
        logger,
        error,
        message: `[listenForLinearEvents] Unexpected error while delivering queued Linear events for job ${cloudJob.id}`,
      });
    }
  }, LINEAR_MESSAGE_CHECK_INTERVAL_MS);
}

import { prependCommunicationMessages } from '@roomote/communication/messages';
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
  cloudJobId: number,
  deliveryOrder: QueuedCommunicationMessage[],
  startIndex: number,
): Promise<void> {
  const remainingQueueOrder = [...deliveryOrder.slice(startIndex)].reverse();
  await prependCommunicationMessages(provider, cloudJobId, remainingQueueOrder);
}

export function createCommunicationMessageInterval({
  provider,
  options,
}: {
  provider: Exclude<CommunicationProvider, 'slack'>;
  options: ListenerOptions;
}): NodeJS.Timeout {
  const { cloudJob, sendPrompt, state, logger, prepareActorScopedTurn } =
    options;
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
      const messages = await runPollingSdkCall({
        execute: () =>
          sdk.cloudJobs.getCommunicationMessages({
            cloudJobId: cloudJob.id,
            provider,
          }),
        stage: `listenFor${provider}Events`,
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'cloudJobs.getCommunicationMessages',
        failurePoint: 'queuedCommunicationMessages',
        logger,
        message: `[listenFor${provider}Events] Failed to check for queued ${provider} messages for job ${cloudJob.id}`,
      });

      if (!messages?.length) {
        return;
      }

      logger.log(
        `[listenFor${provider}Events] Found ${messages.length} queued ${provider} message(s) for job ${cloudJob.id}`,
      );

      const deliveryOrder = [...messages].reverse();
      let index = 0;

      while (index < deliveryOrder.length) {
        const message = deliveryOrder[index]!;
        const allowMcpReconnect =
          !state.phase ||
          !isActiveTaskPhase(state.phase) ||
          state.isConnected === false;

        const canDeliver =
          (await prepareActorScopedTurn(message.userId, {
            allowMcpReconnect,
          })) !== false;

        if (!canDeliver) {
          logger.warn(
            `[listenFor${provider}Events] Delaying ${provider} follow-up for task ${state.sessionId} until actor-scoped turn preparation succeeds`,
          );

          try {
            await requeueCommunicationMessages(
              provider,
              cloudJob.id,
              deliveryOrder,
              index,
            );
          } catch (error) {
            logger.error(
              `[listenFor${provider}Events] Failed to requeue delayed ${provider} message for cloud job ${cloudJob.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          return;
        }

        const prompt =
          message.formattedPrompt ??
          wrapCommunicationMessage(provider, message);
        const sent = sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: provider,
          userId: message.userId,
          clientMessageId: getCommunicationClientMessageId(provider, message),
        });

        if (!sent) {
          logger.warn(
            `[listenFor${provider}Events] Failed to send follow-up prompt for task ${state.sessionId}`,
          );

          try {
            await requeueCommunicationMessages(
              provider,
              cloudJob.id,
              deliveryOrder,
              index,
            );
          } catch (error) {
            logger.error(
              `[listenFor${provider}Events] Failed to requeue ${provider} follow-up for cloud job ${cloudJob.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          return;
        }

        if (provider === 'telegram' || provider === 'teams') {
          // Telegram and Teams turns feed the same satisfaction machinery as
          // Slack so ack/closeout enforcement and current-turn reactions work.
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
        cloudJobId: cloudJob.id,
        sessionId: state.sessionId,
        sdkMethod: 'listenForCommunicationEvents.delivery',
        failurePoint: 'queuedCommunicationDelivery',
        logger,
        error,
        message: `[listenFor${provider}Events] Unexpected error while delivering queued ${provider} events for job ${cloudJob.id}`,
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

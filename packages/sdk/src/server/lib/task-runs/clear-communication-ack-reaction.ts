import {
  getCommunicationProviderFromTaskPayload,
  getDiscordIntakeAckReactionTargetFromTaskPayload,
} from '@roomote/types';

import { getCommunicationProviderAdapter } from '../communication-providers';
import { findTaskRun } from './find-task-run';

/** Fixed intake-ack emoji used by Discord message launches (👀). */
const DISCORD_ACK_REACTION = 'eyes';

type ClearCommunicationAckReactionResult = {
  cleared: boolean;
  reason?:
    | 'run_not_found'
    | 'unsupported_provider'
    | 'missing_target'
    | 'provider_unavailable'
    | 'remove_unsupported'
    | 'remove_failed';
};

/**
 * Removes the platform intake-ack reaction once a communication task runtime
 * has started. Mirrors Slack's worker onStart eyes cleanup for Discord:
 * eyes is a temporary "saw your message" marker, not a lasting status.
 *
 * Runs for Discord launches and snapshot wakes that recorded a pending eyes
 * reaction (dedicated reaction target + discordIntakeAckPending). Interaction
 * launches and resumes without a successful 👀 pin are no-ops.
 */
export async function clearCommunicationAckReaction(input: {
  runId: number;
}): Promise<ClearCommunicationAckReactionResult> {
  const taskRun = await findTaskRun(input.runId);
  if (!taskRun) {
    return { cleared: false, reason: 'run_not_found' };
  }

  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (provider !== 'discord') {
    return { cleared: false, reason: 'unsupported_provider' };
  }

  const target = getDiscordIntakeAckReactionTargetFromTaskPayload(
    taskRun.payload,
  );
  if (!target) {
    return { cleared: false, reason: 'missing_target' };
  }

  const adapter = await getCommunicationProviderAdapter('discord');
  if (!adapter) {
    return { cleared: false, reason: 'provider_unavailable' };
  }
  if (!adapter.removeReaction) {
    return { cleared: false, reason: 'remove_unsupported' };
  }

  const reaction = {
    channelId: target.channelId,
    messageId: target.messageId,
    name: DISCORD_ACK_REACTION,
  };

  try {
    await adapter.removeReaction(reaction);
    return { cleared: true };
  } catch (firstError) {
    console.warn(
      `[clearCommunicationAckReaction] Discord reaction cleanup failed for run ${input.runId}; retrying once (emoji=${DISCORD_ACK_REACTION}, channel=${target.channelId}, message=${target.messageId}): ${
        firstError instanceof Error ? firstError.message : String(firstError)
      }`,
    );

    try {
      await adapter.removeReaction(reaction);
      return { cleared: true };
    } catch (retryError) {
      console.warn(
        `[clearCommunicationAckReaction] Discord reaction cleanup failed after retry for run ${input.runId}: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      );
      return { cleared: false, reason: 'remove_failed' };
    }
  }
}

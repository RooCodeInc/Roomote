import {
  and,
  db,
  eq,
  setTrustedRunActingUser,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  claimPendingSlackPrReviewAction,
  parseSlackPrReviewActionButtonValue,
  type PendingSlackPrReviewAction,
  postSlackInteractiveResponse,
  queueSlackMessage,
  resolveSlackReactionNames,
  type SlackEvent,
  type SlackInteractivePayload,
  SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';
import { processSnapshotResume } from '../events/snapshot-resume.js';
import {
  dispatchSlackThreadFollowUp,
  resolveSlackThreadFollowUpRoute,
} from '../events/thread-follow-up-dispatch.js';

const QUESTION_BLOCK_ID = 'pr_review_action_question';
const ACTIONS_BLOCK_ID = 'pr_review_action';

/**
 * Rewrites the posted notification once the offer is resolved: the question
 * and button blocks are replaced with a one-line resolution note while every
 * other block (summary, relocated footers) is preserved as-is.
 */
function buildResolvedMessageBlocks(
  originalBlocks: unknown[] | undefined,
  resolution: string,
): unknown[] {
  const resolutionBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: resolution }],
  };

  if (!originalBlocks || originalBlocks.length === 0) {
    return [resolutionBlock];
  }

  const kept = originalBlocks.filter((block) => {
    const blockId = (block as { block_id?: unknown }).block_id;

    return blockId !== QUESTION_BLOCK_ID && blockId !== ACTIONS_BLOCK_ID;
  });
  const actionsIndex = originalBlocks.findIndex(
    (block) => (block as { block_id?: unknown }).block_id === ACTIONS_BLOCK_ID,
  );
  // Insert the resolution where the buttons were; fall back to appending.
  const removedBeforeActions = originalBlocks
    .slice(0, actionsIndex < 0 ? 0 : actionsIndex)
    .filter(
      (block) =>
        (block as { block_id?: unknown }).block_id === QUESTION_BLOCK_ID,
    ).length;
  const insertAt =
    actionsIndex < 0 ? kept.length : actionsIndex - removedBeforeActions;

  return [...kept.slice(0, insertAt), resolutionBlock, ...kept.slice(insertAt)];
}

async function updateNotificationMessage({
  slack,
  payload,
  resolution,
}: {
  slack: SlackNotifier;
  payload: SlackInteractivePayload;
  resolution: string;
}): Promise<void> {
  try {
    await slack.updateMessage({
      channel: payload.channel.id,
      ts: payload.message.ts,
      message: {
        blocks: buildResolvedMessageBlocks(payload.message.blocks, resolution),
      },
    });
  } catch (error) {
    apiLogger.warn(
      `[SlackPrReviewAction] Failed to update notification message ${payload.channel.id}/${payload.message.ts}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function getSlackTeamContext(teamId: string) {
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

function parseNonce(payload: SlackInteractivePayload): string | null {
  const action = payload.actions[0];

  if (!action || action.type !== 'button') {
    return null;
  }

  return parseSlackPrReviewActionButtonValue(action.value)?.nonce ?? null;
}

async function respondEphemeral(
  payload: SlackInteractivePayload,
  text: string,
): Promise<void> {
  await postSlackInteractiveResponse(payload.response_url, {
    replace_original: false,
    response_type: 'ephemeral',
    text,
  });
}

/**
 * "Yes, take a look" on a PR review-feedback notification: claim the pending
 * offer and dispatch its follow-up prompt into the owning task's thread —
 * queued into the active run when one is live, or resuming the task from its
 * snapshot when the run already exited. This deliberately rides the same
 * follow-up routing as a typed thread reply so waking a slept task works.
 */
export async function handleSlackPrReviewActionYes(
  payload: SlackInteractivePayload,
): Promise<void> {
  const nonce = parseNonce(payload);

  if (!nonce) {
    apiLogger.warn(
      '[SlackPrReviewAction] Yes click carried no parseable nonce',
    );
    return;
  }

  const userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, payload.user.id),
      eq(slackUserMappings.slackTeamId, payload.team.id),
    ),
  });

  if (!userMapping) {
    // Not claimed: a teammate with a linked account can still accept.
    await respondEphemeral(
      payload,
      'Please connect your Roomote account before starting work from this notification.',
    );
    return;
  }

  const pending = await claimPendingSlackPrReviewAction(nonce);

  if (!pending) {
    await respondEphemeral(
      payload,
      'This offer was already handled or has expired. Reply in the thread to ask again.',
    );
    return;
  }

  try {
    await dispatchPrReviewFollowUp({ payload, pending, userMapping });
  } catch (error) {
    apiLogger.error(
      `[SlackPrReviewAction] Failed to dispatch follow-up for ${pending.repository}#${pending.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await respondEphemeral(
      payload,
      'Failed to start the follow-up. Reply in the thread to ask again.',
    );
  }
}

async function dispatchPrReviewFollowUp({
  payload,
  pending,
  userMapping,
}: {
  payload: SlackInteractivePayload;
  pending: PendingSlackPrReviewAction;
  userMapping: { userId: string };
}): Promise<void> {
  const { slack, slackInstallation } = await getSlackTeamContext(
    payload.team.id,
  );
  const route = await resolveSlackThreadFollowUpRoute({
    threadId: pending.threadTs,
  });

  const result = await dispatchSlackThreadFollowUp({
    route,
    slack,
    channel: pending.channelId,
    threadId: pending.threadTs,
    onActive: async (activeRun) => {
      await setTrustedRunActingUser({
        runId: activeRun.id,
        userId: userMapping.userId,
      });
      await queueSlackMessage(activeRun.id, {
        text: pending.followUpPrompt,
        user: payload.user.id,
        userId: userMapping.userId,
        ts: new Date().toISOString(),
      });

      return true;
    },
    onResume: async (completedRun) => {
      const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();
      // The resume path expects the follow-up as a thread message event;
      // synthesize one carrying the prepared follow-up prompt so the resumed
      // task starts from the same text a typed reply would have delivered.
      const syntheticEvent: SlackEvent = {
        type: 'message',
        channel: pending.channelId,
        user: payload.user.id,
        text: pending.followUpPrompt,
        ts: (Date.now() / 1000).toFixed(6),
        thread_ts: pending.threadTs,
      };

      const handled = await processSnapshotResume(
        syntheticEvent,
        slack,
        completedRun,
        pending.threadTs,
        userMapping.userId,
        ackEmoji,
        completionEmoji,
        slackInstallation.botUserId,
      );

      return handled ? { handled: true, value: true } : { handled: false };
    },
  });

  if (result.kind === 'fresh' || result.value !== true) {
    await respondEphemeral(
      payload,
      'This task can no longer be resumed. Reply in the thread to start fresh.',
    );
    return;
  }

  await updateNotificationMessage({
    slack,
    payload,
    resolution: `:white_check_mark: On it — requested by <@${payload.user.id}>.`,
  });
}

/**
 * "Dismiss" on a PR review-feedback notification: claim the pending offer so
 * the buttons are dead for everyone and note the dismissal on the message.
 */
export async function handleSlackPrReviewActionDismiss(
  payload: SlackInteractivePayload,
): Promise<void> {
  const nonce = parseNonce(payload);

  if (!nonce) {
    apiLogger.warn(
      '[SlackPrReviewAction] Dismiss click carried no parseable nonce',
    );
    return;
  }

  const pending = await claimPendingSlackPrReviewAction(nonce);

  if (!pending) {
    await respondEphemeral(
      payload,
      'This offer was already handled or has expired.',
    );
    return;
  }

  const { slack } = await getSlackTeamContext(payload.team.id);

  await updateNotificationMessage({
    slack,
    payload,
    resolution: `Dismissed by <@${payload.user.id}>.`,
  });
}

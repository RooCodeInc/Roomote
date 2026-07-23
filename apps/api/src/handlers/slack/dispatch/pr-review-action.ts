import {
  and,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  claimPendingPrReviewAction,
  dispatchPrReviewFollowUp,
  enableAutoHandlePrReviewFeedback,
  type PendingPrReviewAction,
} from '@roomote/sdk/server';
import {
  parseSlackPrReviewActionButtonValue,
  postSlackInteractiveResponse,
  type SlackInteractivePayload,
  SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';

async function getSlackTeamNotifier(teamId: string) {
  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!slackInstallation) {
    throw new Error('Slack installation not found');
  }

  return { slack: new SlackNotifier(slackInstallation.botAccessToken) };
}

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
  payload,
  resolution,
}: {
  payload: SlackInteractivePayload;
  resolution: string;
}): Promise<void> {
  try {
    const { slack } = await getSlackTeamNotifier(payload.team.id);

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

async function resolveLinkedUserId(
  payload: SlackInteractivePayload,
): Promise<string | null> {
  const userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, payload.user.id),
      eq(slackUserMappings.slackTeamId, payload.team.id),
    ),
  });

  return userMapping?.userId ?? null;
}

async function handleAcceptedPrReviewAction({
  payload,
  enableAutoHandle,
}: {
  payload: SlackInteractivePayload;
  enableAutoHandle: boolean;
}): Promise<void> {
  const nonce = parseNonce(payload);

  if (!nonce) {
    apiLogger.warn('[SlackPrReviewAction] Click carried no parseable nonce');
    return;
  }

  const userId = await resolveLinkedUserId(payload);

  if (!userId) {
    // Not claimed: a teammate with a linked account can still accept.
    await respondEphemeral(
      payload,
      'Please connect your Roomote account before starting work from this notification.',
    );
    return;
  }

  const pending = await claimPendingPrReviewAction(nonce);

  if (!pending) {
    await respondEphemeral(
      payload,
      'This offer was already handled or has expired. Reply in the thread to ask again.',
    );
    return;
  }

  try {
    await dispatchAcceptedPrReviewAction({
      payload,
      pending,
      userId,
      enableAutoHandle,
    });
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

async function dispatchAcceptedPrReviewAction({
  payload,
  pending,
  userId,
  enableAutoHandle,
}: {
  payload: SlackInteractivePayload;
  pending: PendingPrReviewAction;
  userId: string;
  enableAutoHandle: boolean;
}): Promise<void> {
  if (enableAutoHandle) {
    await enableAutoHandlePrReviewFeedback({
      taskId: pending.taskId,
      repository: pending.repository,
      prNumber: pending.prNumber,
      userId,
    });
  }

  const dispatched = await dispatchPrReviewFollowUp({
    provider: 'slack',
    channelId: pending.channelId,
    threadId: pending.threadId,
    followUpPrompt: pending.followUpPrompt,
    actingUserId: userId,
    providerUserId: payload.user.id,
  });

  if (dispatched.outcome === 'unavailable') {
    await respondEphemeral(
      payload,
      enableAutoHandle
        ? "I'll take future feedback from here, but this task can no longer be resumed for the current one. Reply in the thread to start fresh."
        : 'This task can no longer be resumed. Reply in the thread to start fresh.',
    );

    if (!enableAutoHandle) {
      return;
    }
  }

  const resolution = enableAutoHandle
    ? `Taking it from here — requested by <@${payload.user.id}>. Future review feedback on this PR gets handled in this task.`
    : `On it — requested by <@${payload.user.id}>.`;

  await updateNotificationMessage({ payload, resolution });
}

/**
 * "Yes, take a look": claim the pending offer and dispatch its follow-up
 * prompt into the owning task's thread — queued into the active run when one
 * is live, or resuming the task from its snapshot when the run already
 * exited.
 */
export async function handleSlackPrReviewActionYes(
  payload: SlackInteractivePayload,
): Promise<void> {
  await handleAcceptedPrReviewAction({ payload, enableAutoHandle: false });
}

/**
 * "Take it from here": dispatch the current feedback like Yes and mark the
 * task's PR so future review feedback is dispatched automatically without
 * asking.
 */
export async function handleSlackPrReviewActionAuto(
  payload: SlackInteractivePayload,
): Promise<void> {
  await handleAcceptedPrReviewAction({ payload, enableAutoHandle: true });
}

/**
 * "Dismiss": claim the pending offer so the buttons are dead for everyone and
 * note the dismissal on the message.
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

  const pending = await claimPendingPrReviewAction(nonce);

  if (!pending) {
    await respondEphemeral(
      payload,
      'This offer was already handled or has expired.',
    );
    return;
  }

  await updateNotificationMessage({
    payload,
    resolution: `Dismissed by <@${payload.user.id}>.`,
  });
}

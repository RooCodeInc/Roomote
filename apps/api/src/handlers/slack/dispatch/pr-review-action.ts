import {
  and,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  claimPendingPrReviewAction,
  completePendingPrReviewActionDispatch,
  dispatchPrReviewFollowUp,
  enableAutoHandlePrReviewFeedback,
  type PendingPrReviewAction,
} from '@roomote/sdk/server';
import {
  buildResolvedSlackPrReviewMessageBlocks,
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

async function updateNotificationMessage({
  payload,
  resolution,
  resolutionType,
}: {
  payload: SlackInteractivePayload;
  resolution: string;
  resolutionType?: 'context' | 'section';
}): Promise<void> {
  try {
    const { slack } = await getSlackTeamNotifier(payload.team.id);

    await slack.updateMessage({
      channel: payload.channel.id,
      ts: payload.message.ts,
      message: {
        blocks: buildResolvedSlackPrReviewMessageBlocks(
          payload.message.blocks,
          resolution,
          resolutionType,
        ),
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

  const pending = await claimPendingPrReviewAction(nonce, {
    expectedSlackTeamId: payload.team.id,
    choice: enableAutoHandle ? 'auto' : 'yes',
    actingUserId: userId,
  });

  if (!pending) {
    await updateNotificationMessage({
      payload,
      resolution: 'Already handled or expired.',
    });
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
    await updateNotificationMessage({
      payload,
      resolution: 'Failed to start the follow-up.',
    });
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
  if (enableAutoHandle && !pending.canonicalDeliveryId) {
    await enableAutoHandlePrReviewFeedback({
      taskId: pending.taskId,
      repository: pending.repository,
      prNumber: pending.prNumber,
      userId,
    });
  }

  const dispatched = await dispatchPrReviewFollowUp({
    provider: 'slack',
    taskId: pending.taskId,
    ...(pending.slackTeamId ? { slackTeamId: pending.slackTeamId } : {}),
    channelId: pending.channelId,
    threadId: pending.threadId,
    followUpPrompt: pending.followUpPrompt,
    actingUserId: userId,
    providerUserId: payload.user.id,
    ...(pending.canonicalDeliveryId
      ? { idempotencyKey: `pr-review-delivery:${pending.canonicalDeliveryId}` }
      : {}),
  });

  if (dispatched.outcome === 'unavailable') {
    await respondEphemeral(
      payload,
      enableAutoHandle
        ? "I'll resolve future feedback on this PR, but this task can no longer be resumed for the current feedback. Reply in the thread to start fresh."
        : 'This task can no longer be resumed. Reply in the thread to start fresh.',
    );

    if (!enableAutoHandle) {
      await updateNotificationMessage({
        payload,
        resolution: 'This task can no longer be resumed.',
      });
      return;
    }
  } else {
    await completePendingPrReviewActionDispatch(pending, dispatched.runId);
  }

  const resolution = enableAutoHandle
    ? `OK, <@${payload.user.id}>. Future review feedback on this PR will get resolved automatically.`
    : `On it — requested by <@${payload.user.id}>.`;

  await updateNotificationMessage({
    payload,
    resolution,
    ...(enableAutoHandle ? { resolutionType: 'section' } : {}),
  });
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
 * "Auto-resolve on this PR": dispatch the current feedback like Yes and mark
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

  const pending = await claimPendingPrReviewAction(nonce, {
    expectedSlackTeamId: payload.team.id,
    choice: 'dismiss',
  });

  if (!pending) {
    await updateNotificationMessage({
      payload,
      resolution: 'Already handled or expired.',
    });
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

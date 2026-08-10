import { formatErrorForLog } from '@roomote/types';
import {
  buildSuggestedTasksOnboardingFollowupIgnoreBlocks,
  buildSuggestedTasksOnboardingFollowupPromptTextBlocks,
  claimPendingSuggestedTasksOnboardingFollowupPromptWithNonce,
  getPendingSuggestedTasksOnboardingFollowupPromptWithNonce,
  handleConnectAccount,
  handleFollowupAnswer,
  handleManagerMcpSetupConfigure,
  handleManagerMcpSetupNoThanks,
  handleNevermind,
  handleRoutingConfirmOk,
  handleRoutingRejectNo,
  handleRetryFailedTask,
  handleTaskConfiguration,
  MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID,
  MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID,
  PR_REVIEW_ACTION_AUTO_ACTION_ID,
  PR_REVIEW_ACTION_DISMISS_ACTION_ID,
  PR_REVIEW_ACTION_FIX_ALL_ACTION_ID,
  PR_REVIEW_ACTION_YES_ACTION_ID,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CONFIGURE_ACTION_ID,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_IGNORE_ACTION_ID,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
  SlackNotifier,
  ROOMOTE_SLACK_REPLY_TOGGLE_ACTION_ID,
  type SlackInteractivePayload,
} from '@roomote/slack';
import { and, db, eq, slackInstallations } from '@roomote/db/server';
import {
  handleSlackPrReviewActionAuto,
  handleSlackPrReviewActionDismiss,
  handleSlackPrReviewActionFixAll,
  handleSlackPrReviewActionYes,
} from './pr-review-action.js';
import { handleTaskCancellation } from './task-cancellation.js';
import { handleThreadReplyDetailsToggle } from './thread-reply-details-toggle.js';

function getInteractiveButtonNonce(
  payload: SlackInteractivePayload,
): string | undefined {
  return payload.actions[0]?.type === 'button'
    ? (payload.actions[0].value ?? undefined)
    : undefined;
}

async function handleSuggestedTasksOnboardingFollowupConfigure(
  payload: SlackInteractivePayload,
): Promise<void> {
  const threadId = payload.message.thread_ts || payload.message.ts;
  const expectedNonce = getInteractiveButtonNonce(payload);

  if (!expectedNonce) {
    console.warn(
      `[SuggestedTasksOnboardingFollowupConfigure] Missing nonce for thread ${threadId}; ignoring stale or malformed action`,
    );
    return;
  }

  const pending =
    await claimPendingSuggestedTasksOnboardingFollowupPromptWithNonce({
      threadId,
      expectedNonce,
      expectedSlackUserId: payload.user.id,
    });

  if (!pending) {
    return;
  }
}

async function handleSuggestedTasksOnboardingFollowupIgnore(
  payload: SlackInteractivePayload,
): Promise<void> {
  const threadId = payload.message.thread_ts || payload.message.ts;
  const expectedNonce = getInteractiveButtonNonce(payload);

  if (!expectedNonce) {
    console.warn(
      `[SuggestedTasksOnboardingFollowupIgnore] Missing nonce for thread ${threadId}; ignoring stale or malformed action`,
    );
    return;
  }

  const pending =
    await getPendingSuggestedTasksOnboardingFollowupPromptWithNonce({
      threadId,
      expectedNonce,
      expectedSlackUserId: payload.user.id,
    });

  if (!pending) {
    return;
  }

  const clearButtonsResponse = await fetch(payload.response_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      replace_original: true,
      text: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
      blocks: buildSuggestedTasksOnboardingFollowupPromptTextBlocks(),
    }),
  });

  if (!clearButtonsResponse.ok) {
    const responseBody = await clearButtonsResponse
      .text()
      .catch(() => '<unavailable>');
    console.warn(
      `[SuggestedTasksOnboardingFollowupIgnore] Failed to clear buttons for thread ${threadId}: ${clearButtonsResponse.status} ${clearButtonsResponse.statusText} ${responseBody}`,
    );
    return;
  }

  const claimedPending =
    await claimPendingSuggestedTasksOnboardingFollowupPromptWithNonce({
      threadId,
      expectedNonce,
      expectedSlackUserId: payload.user.id,
    });

  if (!claimedPending) {
    return;
  }

  const ignoreBlocks = buildSuggestedTasksOnboardingFollowupIgnoreBlocks(
    claimedPending.settingsUrl,
  );
  const ignoreText = `OK. If you change your mind, you can <${claimedPending.settingsUrl}|do it here>.`;

  let postedFollowup = false;

  try {
    const slackInstallation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.teamId, claimedPending.slackTeamId),
        eq(slackInstallations.isActive, true),
      ),
      columns: { botAccessToken: true },
    });

    if (slackInstallation) {
      const slack = new SlackNotifier(slackInstallation.botAccessToken);
      const messageTs = await slack.postMessage({
        channel: claimedPending.channelId,
        thread_ts: claimedPending.threadTs,
        text: ignoreText,
        blocks: ignoreBlocks,
      });

      postedFollowup = Boolean(messageTs);
    }
  } catch (error) {
    console.warn(
      `[SuggestedTasksOnboardingFollowupIgnore] Failed to post Slack follow-up for thread ${claimedPending.threadTs}: ${formatErrorForLog(error)}`,
    );
  }

  if (postedFollowup) {
    return;
  }

  await fetch(payload.response_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      replace_original: false,
      text: ignoreText,
      blocks: ignoreBlocks,
    }),
  });
}

export async function handleSlackInteractivePayload(
  interactivePayload: SlackInteractivePayload,
): Promise<void> {
  const actionId =
    interactivePayload.type === 'block_actions'
      ? interactivePayload.actions[0]?.action_id
      : undefined;

  if (interactivePayload.type !== 'block_actions') {
    console.error(
      `❌ Unhandled interactive payload type: ${interactivePayload.type}`,
    );
    return;
  }

  switch (true) {
    case actionId === 'submit_task':
      await handleTaskConfiguration(interactivePayload);
      break;
    case actionId === 'cancel_task':
      await handleTaskCancellation(interactivePayload);
      break;
    case actionId === 'retry_failed_task':
      await handleRetryFailedTask(interactivePayload);
      break;
    case actionId === 'connect_account':
      await handleConnectAccount(interactivePayload);
      break;
    case actionId === 'routing_confirm_ok':
      await handleRoutingConfirmOk(interactivePayload);
      break;
    case actionId === 'routing_confirm_no':
      await handleRoutingRejectNo(interactivePayload);
      break;
    case actionId === MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID:
      await handleManagerMcpSetupConfigure(interactivePayload);
      break;
    case actionId === MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID:
      await handleManagerMcpSetupNoThanks(interactivePayload);
      break;
    case actionId === SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CONFIGURE_ACTION_ID:
      await handleSuggestedTasksOnboardingFollowupConfigure(interactivePayload);
      break;
    case actionId === SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_IGNORE_ACTION_ID:
      await handleSuggestedTasksOnboardingFollowupIgnore(interactivePayload);
      break;
    case actionId === ROOMOTE_SLACK_REPLY_TOGGLE_ACTION_ID:
      await handleThreadReplyDetailsToggle(interactivePayload);
      break;
    case actionId === PR_REVIEW_ACTION_YES_ACTION_ID:
      await handleSlackPrReviewActionYes(interactivePayload);
      break;
    case actionId === PR_REVIEW_ACTION_FIX_ALL_ACTION_ID:
      await handleSlackPrReviewActionFixAll(interactivePayload);
      break;
    case actionId === PR_REVIEW_ACTION_AUTO_ACTION_ID:
      await handleSlackPrReviewActionAuto(interactivePayload);
      break;
    case actionId === PR_REVIEW_ACTION_DISMISS_ACTION_ID:
      await handleSlackPrReviewActionDismiss(interactivePayload);
      break;
    case actionId === 'nevermind_task':
      await handleNevermind(interactivePayload);
      break;
    case actionId === 'agent_selection':
    case actionId === 'workspace_selection':
    case actionId === 'follow_task':
      break;
    case actionId?.startsWith('followup_answer_'):
    case actionId?.startsWith('request_user_input_answer_'):
    case actionId === 'request_user_input_cancel':
      await handleFollowupAnswer(interactivePayload);
      break;
    default:
      console.error(`❌ Unhandled interactive payload action: ${actionId}`);
  }
}

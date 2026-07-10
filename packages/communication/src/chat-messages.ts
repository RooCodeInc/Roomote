import { PRODUCT_NAME } from '@roomote/types';

type TextFormatter = (value: string) => string;
type LinkFormatter = (label: string, url: string) => string;

const identityBenefits = [
  'Associate tasks with you',
  'Access your configured agents',
  'Work with your authorized repositories',
];

function identity(value: string): string {
  return value;
}

export function formatMarkdownLink(label: string, url: string): string {
  return `[${label}](${url})`;
}

export function buildAccountLinkConnectCopy({
  providerName,
  productName = PRODUCT_NAME,
}: {
  providerName: string;
  productName?: string;
}) {
  return {
    fallbackText: `Hi! Let me help you get started with ${productName}.`,
    introText: `Hi, I'm ${productName}.\nI handle the operational engineering work that shows up in ${providerName}: bug reports, escalations, regressions, repo questions, and small fixes.`,
    requirementText: `To get started, I need to link your ${providerName} and ${productName} accounts.`,
    identityBenefits: [...identityBenefits],
    contextText: "This is a one-time deal. We'll be chatting in no time.",
    buttonText: 'Link accounts',
  };
}

export function buildAccountLinkPromptText({
  providerName,
  productName = PRODUCT_NAME,
  accountLinkUrl,
  linkLabel = `this ${providerName} link`,
  formatLink = formatMarkdownLink,
}: {
  providerName: string;
  productName?: string;
  accountLinkUrl: string;
  linkLabel?: string;
  formatLink?: LinkFormatter;
}): string {
  return [
    `I need to link your ${providerName} and ${productName} accounts before I can start tasks for you.`,
    `Open ${formatLink(
      linkLabel,
      accountLinkUrl,
    )} and I'll continue your original request after you sign in.`,
  ].join('\n\n');
}

export function buildAccountLinkThreadReplyText({
  userMention,
  dmPromptSent,
  accountLabel = 'account',
  fallbackInstruction = 'Please open a DM with me and use the Link accounts button.',
}: {
  userMention?: string;
  dmPromptSent: boolean;
  accountLabel?: string;
  fallbackInstruction?: string;
}): string {
  const prefix = userMention ? `${userMention} ` : '';

  if (dmPromptSent) {
    return `${prefix}I sent you a DM to link your ${accountLabel}.`;
  }

  return `${prefix}I need to link your ${accountLabel} before I can help. ${fallbackInstruction}`;
}

export function buildRoutingConfirmationText({
  workspaceDisplayName,
  modelDisplayName,
  formatWorkspaceName = identity,
  formatModelName = identity,
}: {
  workspaceDisplayName: string;
  modelDisplayName?: string;
  formatWorkspaceName?: TextFormatter;
  formatModelName?: TextFormatter;
}): string {
  const workspace = formatWorkspaceName(workspaceDisplayName);
  const model = modelDisplayName?.trim()
    ? ` using ${formatModelName(modelDisplayName)}`
    : '';

  return `I'll get started in ${workspace}${model}, OK?`;
}

export function buildTaskStartingText({
  workspaceDisplayName,
  modelDisplayName,
  formatWorkspaceName = identity,
  formatModelName = identity,
}: {
  workspaceDisplayName: string;
  modelDisplayName?: string;
  formatWorkspaceName?: TextFormatter;
  formatModelName?: TextFormatter;
}): string {
  const workspace = formatWorkspaceName(workspaceDisplayName);
  const model = modelDisplayName?.trim()
    ? ` using ${formatModelName(modelDisplayName)}`
    : '';

  return `Getting started on your task in ${workspace}${model}`;
}

export function buildOtherRunningTasksText(
  otherRunningTasksCount: number | undefined,
): string | null {
  if (
    typeof otherRunningTasksCount !== 'number' ||
    otherRunningTasksCount <= 0
  ) {
    return null;
  }

  return `${otherRunningTasksCount} other task${
    otherRunningTasksCount === 1 ? '' : 's'
  } currently running`;
}

export function buildTaskLaunchAcknowledgementText({
  workspaceDisplayName,
  taskUrl,
  taskLinkLabel = 'open task',
  formatLink = formatMarkdownLink,
}: {
  workspaceDisplayName: string;
  taskUrl?: string;
  taskLinkLabel?: string;
  formatLink?: LinkFormatter;
}): string {
  return taskUrl
    ? `Started a task in ${workspaceDisplayName}: ${formatLink(
        taskLinkLabel,
        taskUrl,
      )}`
    : `Queued a task in ${workspaceDisplayName}.`;
}

export function buildSnapshotResumeAcknowledgementText({
  surfaceName,
  taskUrl,
  taskLinkLabel = 'the task',
  formatLink = formatMarkdownLink,
}: {
  surfaceName: string;
  taskUrl?: string;
  taskLinkLabel?: string;
  formatLink?: LinkFormatter;
}): string {
  if (taskUrl) {
    return `I found the previous task for this ${surfaceName} and reconnected it here: ${formatLink(
      taskLinkLabel,
      taskUrl,
    )}.`;
  }

  return `I found the previous task for this ${surfaceName} and I'm reconnecting it here...`;
}

export type ThreadReplyLinkedPr = {
  prNumber: number;
  prUrl: string;
};

export function buildThreadReplyFooterText({
  taskUrl,
  linkedPr,
  livePreviewUrl,
  explicitMentionRequired = false,
  formatLink = formatMarkdownLink,
}: {
  taskUrl: string;
  linkedPr?: ThreadReplyLinkedPr | null;
  livePreviewUrl?: string | null;
  explicitMentionRequired?: boolean;
  formatLink?: LinkFormatter;
}): string {
  const replyInstruction = explicitMentionRequired
    ? 'reply with @-mention or use'
    : 'reply or use';
  const livePreviewLink = livePreviewUrl
    ? formatLink('live preview', livePreviewUrl)
    : null;
  const webAppLink = formatLink('web app', taskUrl);

  if (linkedPr) {
    const prLink = formatLink(`PR #${linkedPr.prNumber}`, linkedPr.prUrl);
    const workingOn = livePreviewLink
      ? `${prLink}, ${livePreviewLink}`
      : prLink;

    return `_Working on ${workingOn}, ${replyInstruction} the ${webAppLink}._`;
  }

  if (livePreviewLink) {
    return `_Working on a ${livePreviewLink}, ${replyInstruction} the ${webAppLink}._`;
  }

  return explicitMentionRequired
    ? `_Reply with @-mention or use the ${webAppLink}._`
    : `_Reply or use the ${webAppLink}._`;
}

/**
 * Setup onboarding kickoff message posted to the operator's chat surface
 * before the environment-setup task starts. Providers add their own mention
 * formatting via `userMention` (Slack passes `<@user>`; Telegram and Teams
 * omit it).
 */
export function buildSetupKickoffText({
  userMention,
}: {
  userMention?: string | null;
} = {}): string {
  const prefix = userMention ? `${userMention} ` : '';

  return `${prefix}I'm starting your setup now. I'll use this thread for progress updates and follow-up questions. This may take 15 or 20 minutes (yeah, I'm thorough).`;
}

/**
 * Root text for the Slack starter-suggestions intro, where the ideas fan out
 * as thread replies and are launched with a reaction.
 */
export const SETUP_SUGGESTIONS_THREAD_INTRO_TEXT =
  "While setting up your environment, I found a few starter tasks I can already take on.\nReact with a :thumbsup: on one idea in the thread and I'll start it.\nNothing will be merged without your approval. List in the :thread:";

/**
 * Lead line for surfaces that deliver the starter-suggestion ideas inline in
 * a single message (Telegram, Teams). Each surface passes its own start
 * instruction, matching its interaction affordances.
 */
export function buildSetupSuggestionsInlineIntroText({
  startInstruction,
}: {
  startInstruction: string;
}): string {
  return `While setup ran I collected a few starter tasks you could hand me. ${startInstruction}`;
}

export const SETUP_SUGGESTIONS_TELEGRAM_START_INSTRUCTION =
  'Tap one to start it, or just describe your own.';

export const SETUP_SUGGESTIONS_TEAMS_START_INSTRUCTION =
  'Message me the one you want (for example "start idea 2"), or just describe your own.';

/**
 * Interactive Slack variant of the suggested-tasks onboarding follow-up
 * (paired with Configure / No-thanks Block Kit buttons).
 */
export const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_PROMPT_TEXT =
  'Want to receive more ideas like this once in a while? I can make them thematic or cover a specific part of the product, to align with your priorities.';

/**
 * Non-interactive suggested-tasks onboarding follow-up used by surfaces
 * without pending-prompt state (Telegram, Teams). `automationsLabel` carries
 * the surface-appropriate link rendering: plain "Automations" when the link
 * rides in a button, or an inline markdown link otherwise.
 */
export function buildSuggestedTasksFollowupReminderText({
  automationsLabel = 'Automations',
}: {
  automationsLabel?: string;
} = {}): string {
  return [
    'Still thinking about those starter ideas? I can suggest tasks like these on a regular schedule.',
    `Set it up in ${automationsLabel}, or just keep messaging me tasks whenever they come up.`,
  ].join('\n\n');
}

export const TASK_STARTUP_FAILURE_TEXT =
  "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.";

export const TASK_RUNTIME_FAILURE_TEXT =
  "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.";

export function buildPullRequestMergedNotificationText({
  prTitle,
  prUrl,
  mergedBy,
  formatLink = (label) => label,
  formatStatus = identity,
}: {
  prTitle: string;
  prUrl: string;
  mergedBy: string;
  formatLink?: LinkFormatter;
  formatStatus?: TextFormatter;
}): { text: string; bodyText: string } {
  return {
    text: `${prTitle} was merged by ${mergedBy}`,
    bodyText: `${formatLink(prTitle, prUrl)} was ${formatStatus(
      'merged',
    )} by ${mergedBy}`,
  };
}

import {
  listRecentBackgroundAutomationThreadFeedback,
  type BackgroundAutomationThreadFeedback,
} from '@roomote/db/server';
import type { BackgroundAutomationKey } from '@roomote/types';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_THREAD_LIMIT = 3;
const MAX_SUMMARY_CHARS = 280;
const MAX_FEEDBACK_ITEMS_PER_THREAD = 3;
const MAX_FEEDBACK_CHARS = 220;

type AutomationThreadFeedbackReport = {
  promptText: string | null;
  debugSnippet: string;
  threadCount: number;
  feedbackMessageCount: number;
};

function truncateWithEllipsis(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function getIncludedFeedbackItems(
  entry: BackgroundAutomationThreadFeedback,
): string[] {
  return entry.feedbackMessages
    .map((message) => truncateWithEllipsis(message, MAX_FEEDBACK_CHARS))
    .filter(Boolean)
    .slice(0, MAX_FEEDBACK_ITEMS_PER_THREAD);
}

function formatThreadFeedbackEntry(
  entry: BackgroundAutomationThreadFeedback,
): string {
  const lines = [
    `- ${entry.postedAt.toISOString().slice(0, 10)} summary: ${truncateWithEllipsis(entry.summaryText, MAX_SUMMARY_CHARS)}`,
  ];

  const feedbackItems = getIncludedFeedbackItems(entry);

  if (feedbackItems.length > 0) {
    lines.push('  Team feedback:');

    for (const item of feedbackItems) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join('\n');
}

function formatThreadFeedbackSignalLines(
  entry: BackgroundAutomationThreadFeedback,
): string[] {
  const lines = [
    `- ${entry.postedAt.toISOString().slice(0, 10)} summary: ${truncateWithEllipsis(entry.summaryText, MAX_SUMMARY_CHARS)}`,
  ];

  for (const item of getIncludedFeedbackItems(entry)) {
    lines.push(`  - Feedback: ${item}`);
  }

  return lines;
}

function buildAutomationThreadFeedbackDebugSnippet(
  entries: BackgroundAutomationThreadFeedback[],
): string {
  const feedbackMessageCount = entries.reduce(
    (total, entry) => total + getIncludedFeedbackItems(entry).length,
    0,
  );
  const lines = [
    '*Debug: historical Slack-thread signals included in this run*',
    `- Search window: last ${DEFAULT_LOOKBACK_DAYS} days in this channel`,
    `- Prior automation threads included: ${entries.length}`,
    `- User feedback messages included: ${feedbackMessageCount}`,
  ];

  if (entries.length === 0) {
    lines.push(
      '- No prior tracked automation threads matched this run, so no Slack-thread feedback context was added.',
    );
    return lines.join('\n');
  }

  lines.push('- Included signals:');

  for (const entry of entries) {
    lines.push(...formatThreadFeedbackSignalLines(entry));
  }

  return lines.join('\n');
}

async function loadAutomationThreadFeedbackEntries(params: {
  automationKey: BackgroundAutomationKey;
  slackChannelId: string;
  now?: Date;
}): Promise<BackgroundAutomationThreadFeedback[]> {
  const now = params.now ?? new Date();
  const since = new Date(
    now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  return listRecentBackgroundAutomationThreadFeedback({
    automationKey: params.automationKey,
    slackChannelId: params.slackChannelId,
    since,
    limit: DEFAULT_THREAD_LIMIT,
  });
}

export async function loadAutomationThreadFeedbackContext(params: {
  automationKey: BackgroundAutomationKey;
  slackChannelId: string;
  now?: Date;
}): Promise<string | null> {
  const entries = await loadAutomationThreadFeedbackEntries(params);
  if (entries.length === 0) {
    return null;
  }

  return entries.map((entry) => formatThreadFeedbackEntry(entry)).join('\n\n');
}

export async function loadAutomationThreadFeedbackReport(params: {
  automationKey: BackgroundAutomationKey;
  slackChannelId: string;
  now?: Date;
}): Promise<AutomationThreadFeedbackReport> {
  const entries = await loadAutomationThreadFeedbackEntries(params);
  const promptText =
    entries.length === 0
      ? null
      : entries.map((entry) => formatThreadFeedbackEntry(entry)).join('\n\n');
  const feedbackMessageCount = entries.reduce(
    (total, entry) => total + getIncludedFeedbackItems(entry).length,
    0,
  );

  return {
    promptText,
    debugSnippet: buildAutomationThreadFeedbackDebugSnippet(entries),
    threadCount: entries.length,
    feedbackMessageCount,
  };
}

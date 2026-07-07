import { getConfiguredRouterDebugSlackChannelId } from '@roomote/db/server';
import type { SlackNotifier } from '@roomote/slack';

const MAX_MESSAGE_PREVIEW_LENGTH = 300;

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return trimmed.slice(0, maxLength - 3) + '...';
}

export async function postChannelAutoStartRoutingDebug(params: {
  slack: Pick<SlackNotifier, 'isAppInChannel' | 'postMessage'>;
  sourceChannelId: string;
  sourceChannelName?: string | null;
  threadId: string;
  messageText: string;
  launchMode: string;
  llmDecision: 'launch' | 'skip' | 'not_run' | 'error';
  llmReason: string;
  taskOutcome:
    | 'started'
    | 'skipped_before_start'
    | 'replied_inline'
    | 'not_started';
  taskOutcomeDetails?: string;
}): Promise<void> {
  const debugChannelId = await getConfiguredRouterDebugSlackChannelId();

  if (!debugChannelId) {
    return;
  }

  const sourceChannelName = params.sourceChannelName?.trim();
  const messagePreview =
    truncate(params.messageText, MAX_MESSAGE_PREVIEW_LENGTH) || '(empty)';
  const taskOutcomeDetails = params.taskOutcomeDetails?.trim();

  const text = [
    'Configured channel auto-start debug',
    `source_channel: ${params.sourceChannelId}${sourceChannelName ? ` (#${sourceChannelName})` : ''}`,
    `thread: ${params.threadId}`,
    `launch_mode: ${params.launchMode}`,
    `llm_decision: ${params.llmDecision}`,
    `llm_reason: ${params.llmReason}`,
    `task_outcome: ${params.taskOutcome}`,
    taskOutcomeDetails ? `task_outcome_details: ${taskOutcomeDetails}` : null,
    `message: ${messagePreview}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const hasDebugChannelAccess =
      await params.slack.isAppInChannel(debugChannelId);

    if (hasDebugChannelAccess !== true) {
      return;
    }

    await params.slack.postMessage({
      channel: debugChannelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      `[SlackChannelAutoStartDebug] Failed to post routing debug message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

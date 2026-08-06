import { buildManagerAutomationRootSummaryPromptContract } from '@roomote/cloud-agents/server';
import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server/non-task-provider-usage';

import { apiLogger } from '../../logging';
import type { ScheduledSuggestionSlackConfig } from './background-automation-slack';

type ScheduledSuggestionRootMessage = {
  summaryText: string;
  actionFooterText: string;
};

export type RootSummarySuggestion = {
  title: string;
  brief: string;
  category: string | null;
  targetRepositoryFullName: string | null;
};

/**
 * The Suggested Tasks (suggester) parent note must always be composed
 * deterministically from the structured suggestions payload.
 * Routing the parent note through a free-text model call lets raw model
 * narration (including harness output such as CLI run headers) become the
 * channel parent message, so the suggester never uses the generated summary.
 */
export function usesDeterministicScheduledSuggestionRootSummary(
  slackConfig: ScheduledSuggestionSlackConfig,
): boolean {
  return slackConfig.summaryKind === 'suggested_tasks';
}

export function buildDeterministicScheduledSuggestionSummary(params: {
  slackConfig: ScheduledSuggestionSlackConfig;
  suggestions: RootSummarySuggestion[];
}): string {
  const visibleSuggestions = params.suggestions.slice(0, 3);
  const lines = visibleSuggestions.map(
    (suggestion) => `- ${suggestion.title.trim()}`,
  );
  const remainingCount = params.suggestions.length - visibleSuggestions.length;
  const overflowLabel = params.slackConfig.summaryPrompt.overflowLabel;

  if (remainingCount > 0) {
    lines.push(
      `- ${remainingCount} more ${overflowLabel}${remainingCount === 1 ? '' : 's'} in the thread`,
    );
  }

  return [params.slackConfig.summaryPrompt.fallbackLead, lines.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

function buildScheduledSuggestionSummaryPrompt(params: {
  slackConfig: ScheduledSuggestionSlackConfig;
  suggestions: RootSummarySuggestion[];
}): string {
  const items = params.suggestions
    .map((suggestion) =>
      [
        `- ${suggestion.title}`,
        suggestion.brief,
        suggestion.targetRepositoryFullName
          ? `Repository: ${suggestion.targetRepositoryFullName}`
          : null,
        suggestion.category ? `Category: ${suggestion.category}` : null,
      ]
        .filter(Boolean)
        .join('\n  '),
    )
    .join('\n');

  return `You are writing the top-level Slack summary for ${params.slackConfig.summaryPrompt.automationDescription}.

The individual launchable actions will be posted in the thread. Write a concise parent message that helps a manager understand what happened in this run and what deserves attention first.

${buildManagerAutomationRootSummaryPromptContract({
  detailLabel: 'actions',
  highlightLabel: params.slackConfig.summaryPrompt.highlightLabel,
  openerSignal: params.slackConfig.summaryPrompt.openerSignal,
  openerExamples: params.slackConfig.summaryPrompt.openerExamples,
})}

Additional guidance:
- ${params.slackConfig.summaryPrompt.mainActionLine}
- Group related actions together when useful.

Suggested actions:
${items}

Return only the final Slack-formatted message.`;
}

export async function buildScheduledSuggestionRootMessage(params: {
  slackConfig: ScheduledSuggestionSlackConfig;
  actionFooterText: string;
  suggestions: RootSummarySuggestion[];
}): Promise<ScheduledSuggestionRootMessage> {
  let summaryText = buildDeterministicScheduledSuggestionSummary({
    slackConfig: params.slackConfig,
    suggestions: params.suggestions,
  });

  if (usesDeterministicScheduledSuggestionRootSummary(params.slackConfig)) {
    return {
      summaryText,
      actionFooterText: params.actionFooterText,
    };
  }

  try {
    const cleaned = (
      await generateTrackedNonTaskText({
        surface: NON_TASK_INFERENCE_SURFACES.taskSummaryGeneration,
        prompt: buildScheduledSuggestionSummaryPrompt({
          slackConfig: params.slackConfig,
          suggestions: params.suggestions,
        }),
      })
    ).trim();

    if (cleaned.length > 0) {
      summaryText = cleaned;
    }
  } catch (error) {
    apiLogger.warn(
      `[submitTaskSuggestions] Failed to generate ${params.slackConfig.summaryKind} root summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    summaryText,
    actionFooterText: params.actionFooterText,
  };
}

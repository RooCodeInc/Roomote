import { agentSuggestionMessages, and, db, eq, like } from '@roomote/db/server';

import { apiLogger } from '../../logging';

/**
 * Shared lifecycle helpers for the setup-onboarding starter-suggestion
 * posts. Every chat surface (Slack, Telegram, Teams) uses the same tracked
 * rows in `agent_suggestion_messages` for dedup and launch claims; only the
 * message shape differs per surface.
 */
export const SETUP_ONBOARDING_SUGGESTION_AGENT_TYPE =
  'setup_onboarding' as const;

export const MAX_SETUP_SUGGESTIONS = 5;

export type SetupSuggestionSummary = {
  id: string;
  title: string;
  brief: string;
};

/**
 * One post per source task across every surface: when any surface already
 * tracked messages for this task, the fan-out is done.
 */
export async function hasTrackedSetupSuggestionMessages(
  sourceTaskId: string,
): Promise<boolean> {
  const [existingTaskMessage] = await db
    .select({ id: agentSuggestionMessages.id })
    .from(agentSuggestionMessages)
    .where(
      and(
        eq(
          agentSuggestionMessages.agentType,
          SETUP_ONBOARDING_SUGGESTION_AGENT_TYPE,
        ),
        like(agentSuggestionMessages.suggestionKey, `${sourceTaskId}:%`),
      ),
    )
    .limit(1);

  return Boolean(existingTaskMessage);
}

type SetupSuggestionMessageRow = {
  messageTs: string;
  channelId: string;
  suggestionKey: string;
  createdByUserId: string;
};

export async function insertSetupSuggestionMessageRows(
  rows: SetupSuggestionMessageRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await db
    .insert(agentSuggestionMessages)
    .values(
      rows.map((row) => ({
        agentType: SETUP_ONBOARDING_SUGGESTION_AGENT_TYPE,
        ...row,
      })),
    )
    .onConflictDoNothing({
      target: [
        agentSuggestionMessages.channelId,
        agentSuggestionMessages.messageTs,
      ],
    });
}

/**
 * Tracked rows for surfaces that deliver all ideas inside one message
 * (Telegram, Teams). All suggestions share one message, but (channelId,
 * messageTs) is unique — the suggestion id suffix keeps every tracked row
 * alive through the batch insert. Nothing reads these rows back by
 * messageTs; claims match on channelId + suggestionKey.
 */
export function buildSharedMessageSuggestionRows({
  messageId,
  channelId,
  sourceTaskId,
  createdByUserId,
  suggestions,
}: {
  messageId: string;
  channelId: string;
  sourceTaskId: string;
  createdByUserId: string;
  suggestions: SetupSuggestionSummary[];
}): SetupSuggestionMessageRow[] {
  return suggestions.map((suggestion) => ({
    messageTs: `${messageId}:${suggestion.id}`,
    channelId,
    suggestionKey: `${sourceTaskId}:${suggestion.id}`,
    createdByUserId,
  }));
}

/**
 * Numbered idea lines appended below the inline intro on single-message
 * surfaces.
 */
export function buildInlineSuggestionIdeaLines(
  suggestions: SetupSuggestionSummary[],
): string[] {
  return suggestions.map(
    (suggestion, index) =>
      `**${index + 1}. ${suggestion.title}**\n${suggestion.brief}`,
  );
}

/**
 * Schedule the 24h suggested-tasks follow-up for a surface with shared
 * best-effort logging; a scheduling failure never fails the suggestion post.
 */
export async function scheduleSuggestedTasksFollowupBestEffort({
  surfaceLabel,
  sourceTaskId,
  enqueue,
}: {
  surfaceLabel: string;
  sourceTaskId: string;
  enqueue: () => Promise<{ enqueued: boolean; reason?: string }>;
}): Promise<void> {
  try {
    const enqueueResult = await enqueue();

    apiLogger.debug(
      `[SetupSuggestionLifecycle] ${surfaceLabel} suggested-tasks follow-up schedule result for sourceTaskId=${sourceTaskId}: ${
        enqueueResult.enqueued
          ? 'enqueued'
          : (enqueueResult.reason ?? 'skipped')
      }`,
    );
  } catch (error) {
    apiLogger.warn(
      `[SetupSuggestionLifecycle] Failed to schedule ${surfaceLabel} suggested-tasks follow-up for sourceTaskId=${sourceTaskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

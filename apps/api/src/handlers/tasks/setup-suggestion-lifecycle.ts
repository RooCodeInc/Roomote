import type { TrackedMessageSurface } from '@roomote/types';
import { and, db, eq, sql, trackedMessages } from '@roomote/db/server';

import { apiLogger } from '../../logging';

/**
 * Shared lifecycle helpers for the setup-onboarding starter-suggestion
 * posts. Every chat surface (Slack, Telegram, Teams) uses the same tracked
 * rows in `tracked_messages` (kind `suggestion_card`) for dedup and launch
 * claims; only the message shape differs per surface. The launch state
 * machine lives on the backing `work_items` row referenced by `workItemId`.
 */
export const SETUP_ONBOARDING_SUGGESTION_TYPE = 'setup_onboarding' as const;

export const MAX_SETUP_SUGGESTIONS = 5;

export type SetupSuggestionSummary = {
  id: string;
  title: string;
  brief: string;
};

/**
 * One post per source task across every surface: when any surface already
 * tracked messages for this task, the fan-out is done. Setup-onboarding
 * suggestion cards carry `metadata.suggestionType = 'setup_onboarding'` and
 * `metadata.suggestionKey = '<sourceTaskId>:<suggestionId>'`.
 */
export async function hasTrackedSetupSuggestionMessages(
  sourceTaskId: string,
): Promise<boolean> {
  const [existingTaskMessage] = await db
    .select({ id: trackedMessages.id })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.kind, 'suggestion_card'),
        sql`${trackedMessages.metadata} ->> 'suggestionType' = ${SETUP_ONBOARDING_SUGGESTION_TYPE}`,
        sql`${trackedMessages.metadata} ->> 'suggestionKey' LIKE ${`${sourceTaskId}:%`}`,
      ),
    )
    .limit(1);

  return Boolean(existingTaskMessage);
}

type SetupSuggestionMessageRow = {
  surface: TrackedMessageSurface;
  messageTs: string;
  channelId: string;
  workItemId: string;
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
    .insert(trackedMessages)
    .values(
      rows.map((row) => ({
        surface: row.surface,
        kind: 'suggestion_card' as const,
        dedupeKey: `${row.channelId}:${row.messageTs}`,
        channelId: row.channelId,
        messageTs: row.messageTs,
        workItemId: row.workItemId,
        createdByUserId: row.createdByUserId,
        metadata: {
          suggestionType: SETUP_ONBOARDING_SUGGESTION_TYPE,
          suggestionKey: row.suggestionKey,
        },
      })),
    )
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    });
}

/**
 * Tracked rows for surfaces that deliver all ideas inside one message
 * (Telegram, Teams). All suggestions share one message, but the suggestion id
 * suffix on `messageTs` keeps `(kind, dedupeKey)` unique so every tracked row
 * survives the batch insert. `workItemId` is the suggestion's backing
 * `work_items` row; reaction/button launches CAS its status.
 */
export function buildSharedMessageSuggestionRows({
  surface,
  messageId,
  channelId,
  sourceTaskId,
  createdByUserId,
  suggestions,
}: {
  surface: TrackedMessageSurface;
  messageId: string;
  channelId: string;
  sourceTaskId: string;
  createdByUserId: string;
  suggestions: SetupSuggestionSummary[];
}): SetupSuggestionMessageRow[] {
  return suggestions.map((suggestion) => ({
    surface,
    messageTs: `${messageId}:${suggestion.id}`,
    channelId,
    workItemId: suggestion.id,
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

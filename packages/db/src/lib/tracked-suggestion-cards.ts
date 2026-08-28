import { and, eq, inArray } from 'drizzle-orm';
import type { TrackedMessageSurface } from '@roomote/types';

import { db } from '../db';
import { trackedMessages } from '../schema';

type SuggestionCardRegistration = {
  surface: TrackedMessageSurface;
  channelId: string;
  messageTs: string;
  threadTs?: string | null;
  workItemId: string;
  createdByUserId: string | null;
  suggestionType: string;
  suggestionKey: string;
  suggestionGroupKey?: string;
  launchRouting?: 'router';
};

export async function registerTrackedSuggestionCards(
  registrations: SuggestionCardRegistration[],
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  if (registrations.length === 0) return;

  await executor
    .insert(trackedMessages)
    .values(
      registrations.map((registration) => ({
        surface: registration.surface,
        kind: 'suggestion_card' as const,
        dedupeKey: `${registration.channelId}:${registration.messageTs}`,
        channelId: registration.channelId,
        messageTs: registration.messageTs,
        ...(registration.threadTs ? { threadTs: registration.threadTs } : {}),
        workItemId: registration.workItemId,
        createdByUserId: registration.createdByUserId,
        metadata: {
          suggestionType: registration.suggestionType,
          suggestionKey: registration.suggestionKey,
          ...(registration.suggestionGroupKey
            ? { suggestionGroupKey: registration.suggestionGroupKey }
            : {}),
          ...(registration.launchRouting
            ? { launchRouting: registration.launchRouting }
            : {}),
        },
      })),
    )
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    });
}

export async function findTrackedSuggestionWorkItemIds(params: {
  surface: TrackedMessageSurface;
  workItemIds: string[];
}): Promise<Set<string>> {
  if (params.workItemIds.length === 0) return new Set();

  const cards = await db
    .select({ workItemId: trackedMessages.workItemId })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, params.surface),
        eq(trackedMessages.kind, 'suggestion_card'),
        inArray(trackedMessages.workItemId, params.workItemIds),
      ),
    );

  return new Set(
    cards
      .map((card) => card.workItemId)
      .filter((workItemId): workItemId is string => Boolean(workItemId)),
  );
}

import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { slackConversationMessages, trackedMessages } from '../schema';
import type {
  BackgroundAutomationKey,
  TrackedMessageSurface,
} from '@roomote/types';

export type BackgroundAutomationThreadFeedback = {
  threadTs: string;
  summaryText: string;
  postedAt: Date;
  feedbackMessages: string[];
};

/**
 * Automation root threads are tracked_messages rows of kind
 * 'automation_thread', deduped on `${channelId}:${threadTs}`.
 */
function automationThreadDedupeKey(params: {
  slackChannelId: string;
  threadTs: string;
}): string {
  return `${params.slackChannelId}:${params.threadTs}`;
}

export async function upsertBackgroundAutomationSlackThread(
  tx: DatabaseOrTransaction,
  params: {
    surface: TrackedMessageSurface;
    automationKey: BackgroundAutomationKey;
    slackChannelId: string;
    threadTs: string;
    summaryText: string;
    postedAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date();
  const dedupeKey = automationThreadDedupeKey(params);

  await tx
    .insert(trackedMessages)
    .values({
      surface: params.surface,
      kind: 'automation_thread',
      dedupeKey,
      channelId: params.slackChannelId,
      threadTs: params.threadTs,
      automationKey: params.automationKey,
      summaryText: params.summaryText.trim(),
      postedAt: params.postedAt,
      metadata: params.metadata ?? {},
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
      set: {
        automationKey: params.automationKey,
        summaryText: params.summaryText.trim(),
        postedAt: params.postedAt,
        metadata: params.metadata ?? {},
        updatedAt: now,
      },
    });
}

export type BackgroundAutomationSlackThreadRow = {
  id: string;
  automationKey: BackgroundAutomationKey | null;
  slackChannelId: string;
  threadTs: string | null;
  summaryText: string;
  postedAt: Date;
  metadata: Record<string, unknown>;
};

function toBackgroundAutomationSlackThreadRow(row: {
  id: string;
  automationKey: BackgroundAutomationKey | null;
  channelId: string;
  threadTs: string | null;
  summaryText: string;
  postedAt: Date;
  metadata: Record<string, unknown>;
}): BackgroundAutomationSlackThreadRow {
  return {
    id: row.id,
    automationKey: row.automationKey,
    slackChannelId: row.channelId,
    threadTs: row.threadTs,
    summaryText: row.summaryText,
    postedAt: row.postedAt,
    metadata: row.metadata,
  };
}

export async function findBackgroundAutomationSlackThread(params: {
  surface: TrackedMessageSurface;
  slackChannelId: string;
  threadTs: string;
}): Promise<BackgroundAutomationSlackThreadRow | undefined> {
  const row = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.surface, params.surface),
      eq(trackedMessages.kind, 'automation_thread'),
      eq(trackedMessages.dedupeKey, automationThreadDedupeKey(params)),
    ),
    columns: {
      id: true,
      automationKey: true,
      channelId: true,
      threadTs: true,
      summaryText: true,
      postedAt: true,
      metadata: true,
    },
  });

  return row ? toBackgroundAutomationSlackThreadRow(row) : undefined;
}

export async function updateBackgroundAutomationSlackThreadMetadata(
  tx: DatabaseOrTransaction,
  params: {
    surface: TrackedMessageSurface;
    slackChannelId: string;
    threadTs: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const dedupeKey = automationThreadDedupeKey(params);

  const [existing] = await tx
    .select({
      metadata: trackedMessages.metadata,
    })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, params.surface),
        eq(trackedMessages.kind, 'automation_thread'),
        eq(trackedMessages.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);

  if (!existing) {
    return false;
  }

  await tx
    .update(trackedMessages)
    .set({
      metadata: {
        ...(existing.metadata ?? {}),
        ...params.metadata,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(trackedMessages.surface, params.surface),
        eq(trackedMessages.kind, 'automation_thread'),
        eq(trackedMessages.dedupeKey, dedupeKey),
      ),
    );

  return true;
}

export async function listRecentBackgroundAutomationThreadFeedback(params: {
  surface: TrackedMessageSurface;
  automationKey: BackgroundAutomationKey;
  slackChannelId: string;
  since?: Date;
  limit?: number;
}): Promise<BackgroundAutomationThreadFeedback[]> {
  const threadRows = await db
    .select({
      threadTs: trackedMessages.threadTs,
      summaryText: trackedMessages.summaryText,
      postedAt: trackedMessages.postedAt,
    })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, params.surface),
        eq(trackedMessages.kind, 'automation_thread'),
        eq(trackedMessages.automationKey, params.automationKey),
        eq(trackedMessages.channelId, params.slackChannelId),
        params.since ? gte(trackedMessages.postedAt, params.since) : undefined,
      ),
    )
    .orderBy(desc(trackedMessages.postedAt))
    .limit(params.limit ?? 5);

  const threadTimestamps = threadRows
    .map((row) => row.threadTs)
    .filter((threadTs): threadTs is string => Boolean(threadTs));

  if (threadTimestamps.length === 0) {
    return [];
  }

  // Reply harvesting reads the persisted Slack conversation log, so threads
  // tracked on other surfaces resolve with empty feedbackMessages until those
  // surfaces get an equivalent reply source.
  const feedbackRows = await db
    .select({
      threadTs: slackConversationMessages.threadTs,
      text: slackConversationMessages.text,
      messageAt: slackConversationMessages.messageAt,
    })
    .from(slackConversationMessages)
    .where(
      and(
        eq(slackConversationMessages.slackChannelId, params.slackChannelId),
        eq(slackConversationMessages.conversationKind, 'thread'),
        eq(slackConversationMessages.direction, 'inbound'),
        eq(slackConversationMessages.authorKind, 'user'),
        inArray(slackConversationMessages.threadTs, threadTimestamps),
      ),
    )
    .orderBy(slackConversationMessages.messageAt);

  const feedbackByThread = new Map<string, string[]>();

  for (const row of feedbackRows) {
    if (!row.threadTs) {
      continue;
    }

    const messages = feedbackByThread.get(row.threadTs) ?? [];

    if (row.text.trim()) {
      messages.push(row.text.trim());
    }

    feedbackByThread.set(row.threadTs, messages);
  }

  return threadRows.flatMap((row) =>
    row.threadTs
      ? [
          {
            threadTs: row.threadTs,
            summaryText: row.summaryText,
            postedAt: row.postedAt,
            feedbackMessages: feedbackByThread.get(row.threadTs) ?? [],
          },
        ]
      : [],
  );
}

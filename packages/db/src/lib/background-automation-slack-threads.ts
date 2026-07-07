import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import {
  backgroundAutomationSlackThreads,
  slackConversationMessages,
} from '../schema';
import type { BackgroundAutomationKey } from '@roomote/types';

export type BackgroundAutomationThreadFeedback = {
  threadTs: string;
  summaryText: string;
  postedAt: Date;
  feedbackMessages: string[];
};

export async function upsertBackgroundAutomationSlackThread(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: BackgroundAutomationKey;
    slackChannelId: string;
    threadTs: string;
    summaryText: string;
    postedAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date();

  await tx
    .insert(backgroundAutomationSlackThreads)
    .values({
      automationKey: params.automationKey,
      slackChannelId: params.slackChannelId,
      threadTs: params.threadTs,
      summaryText: params.summaryText.trim(),
      postedAt: params.postedAt,
      metadata: params.metadata ?? {},
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        backgroundAutomationSlackThreads.slackChannelId,
        backgroundAutomationSlackThreads.threadTs,
      ],
      set: {
        automationKey: params.automationKey,
        summaryText: params.summaryText.trim(),
        postedAt: params.postedAt,
        metadata: params.metadata ?? {},
        updatedAt: now,
      },
    });
}

export async function findBackgroundAutomationSlackThread(params: {
  slackChannelId: string;
  threadTs: string;
}) {
  return db.query.backgroundAutomationSlackThreads.findFirst({
    where: and(
      eq(
        backgroundAutomationSlackThreads.slackChannelId,
        params.slackChannelId,
      ),
      eq(backgroundAutomationSlackThreads.threadTs, params.threadTs),
    ),
  });
}

export async function updateBackgroundAutomationSlackThreadMetadata(
  tx: DatabaseOrTransaction,
  params: {
    slackChannelId: string;
    threadTs: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const [existing] = await tx
    .select({
      metadata: backgroundAutomationSlackThreads.metadata,
    })
    .from(backgroundAutomationSlackThreads)
    .where(
      and(
        eq(
          backgroundAutomationSlackThreads.slackChannelId,
          params.slackChannelId,
        ),
        eq(backgroundAutomationSlackThreads.threadTs, params.threadTs),
      ),
    )
    .limit(1);

  if (!existing) {
    return false;
  }

  await tx
    .update(backgroundAutomationSlackThreads)
    .set({
      metadata: {
        ...(existing.metadata ?? {}),
        ...params.metadata,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(
          backgroundAutomationSlackThreads.slackChannelId,
          params.slackChannelId,
        ),
        eq(backgroundAutomationSlackThreads.threadTs, params.threadTs),
      ),
    );

  return true;
}

export async function listRecentBackgroundAutomationThreadFeedback(params: {
  automationKey: BackgroundAutomationKey;
  slackChannelId: string;
  since?: Date;
  limit?: number;
}): Promise<BackgroundAutomationThreadFeedback[]> {
  const threadRows = await db
    .select({
      threadTs: backgroundAutomationSlackThreads.threadTs,
      summaryText: backgroundAutomationSlackThreads.summaryText,
      postedAt: backgroundAutomationSlackThreads.postedAt,
    })
    .from(backgroundAutomationSlackThreads)
    .where(
      and(
        eq(
          backgroundAutomationSlackThreads.automationKey,
          params.automationKey,
        ),
        eq(
          backgroundAutomationSlackThreads.slackChannelId,
          params.slackChannelId,
        ),
        params.since
          ? gte(backgroundAutomationSlackThreads.postedAt, params.since)
          : undefined,
      ),
    )
    .orderBy(desc(backgroundAutomationSlackThreads.postedAt))
    .limit(params.limit ?? 5);

  if (threadRows.length === 0) {
    return [];
  }

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
        inArray(
          slackConversationMessages.threadTs,
          threadRows.map((row) => row.threadTs),
        ),
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

  return threadRows.map((row) => ({
    threadTs: row.threadTs,
    summaryText: row.summaryText,
    postedAt: row.postedAt,
    feedbackMessages: feedbackByThread.get(row.threadTs) ?? [],
  }));
}

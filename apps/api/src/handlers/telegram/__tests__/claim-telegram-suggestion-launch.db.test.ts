// pnpm --filter @roomote/api test telegram/__tests__/claim-telegram-suggestion-launch.db.test.ts
//
// Real-DB coverage for the reaction/button launch CAS on work_items. The
// launch claim moved from agent_suggestion_messages to work_items in the Stage
// 4 merge: a suggestion_card tracked_messages row points at a work_items row,
// and claiming a launch flips that row open -> launching exactly once (with a
// 10-minute stale-claim recovery window). claimTelegramSuggestionLaunch runs
// the same CAS the Slack reaction launcher uses.

import {
  db,
  eq,
  inArray,
  trackedMessages,
  workItems,
} from '@roomote/db/server';

import { claimTelegramSuggestionLaunch } from '../setup-suggestions';

describe('claimTelegramSuggestionLaunch (work_items launch CAS)', () => {
  const workItemIds: string[] = [];
  const chatId = `telegram-chat-${Date.now()}`;

  async function seedSuggestionWorkItem(overrides?: {
    status?: 'open' | 'launching' | 'launched';
    launchClaimedAt?: Date | null;
    channelId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Fix the flaky test',
        brief: 'The retry loop never terminates.',
        investigationContext: 'See CI run 42.',
        targetRepositoryFullName: 'acme/app',
        sortOrder: workItemIds.length,
        status: overrides?.status ?? 'open',
        launchClaimedAt: overrides?.launchClaimedAt ?? null,
      })
      .returning({ id: workItems.id });

    const workItemId = row!.id;
    workItemIds.push(workItemId);

    await db.insert(trackedMessages).values({
      surface: 'telegram',
      kind: 'suggestion_card',
      dedupeKey: `${overrides?.channelId ?? chatId}:${workItemId}`,
      channelId: overrides?.channelId ?? chatId,
      messageTs: `msg:${workItemId}`,
      workItemId,
      metadata: {
        suggestionType: 'setup_onboarding',
        suggestionKey: `source-task:${workItemId}`,
      },
    });

    return workItemId;
  }

  afterEach(async () => {
    if (workItemIds.length > 0) {
      await db
        .delete(trackedMessages)
        .where(inArray(trackedMessages.workItemId, workItemIds));
      await db.delete(workItems).where(inArray(workItems.id, workItemIds));
      workItemIds.length = 0;
    }
  });

  it('claims an open work item exactly once and flips it to launching', async () => {
    const workItemId = await seedSuggestionWorkItem();

    const claimed = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(workItemId);
    expect(claimed?.title).toBe('Fix the flaky test');

    const [row] = await db
      .select({
        status: workItems.status,
        launchClaimedAt: workItems.launchClaimedAt,
      })
      .from(workItems)
      .where(eq(workItems.id, workItemId))
      .limit(1);

    expect(row?.status).toBe('launching');
    expect(row?.launchClaimedAt).toBeInstanceOf(Date);
  });

  it('returns null for a second claim (double-tap is a no-op)', async () => {
    const workItemId = await seedSuggestionWorkItem();

    const first = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });
    const second = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('does not claim a launched work item', async () => {
    const workItemId = await seedSuggestionWorkItem({ status: 'launched' });

    const claimed = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });

    expect(claimed).toBeNull();
  });

  it('recovers a stale claim older than the 10-minute window', async () => {
    // status stays open but launchClaimedAt is stale (a launcher that never
    // finalized). The CAS reclaims it.
    const staleClaimedAt = new Date(Date.now() - 11 * 60 * 1000);
    const workItemId = await seedSuggestionWorkItem({
      status: 'open',
      launchClaimedAt: staleClaimedAt,
    });

    const claimed = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(workItemId);
  });

  it('does not claim when the tracked card belongs to another chat', async () => {
    // The card was posted to a different chat, so this chat cannot claim it.
    const workItemId = await seedSuggestionWorkItem({
      channelId: `other-chat-${Date.now()}`,
    });

    const claimed = await claimTelegramSuggestionLaunch({
      suggestionId: workItemId,
      chatId,
    });

    expect(claimed).toBeNull();

    // The work item is untouched (still open) since the scope check failed.
    const [row] = await db
      .select({ status: workItems.status })
      .from(workItems)
      .where(eq(workItems.id, workItemId))
      .limit(1);
    expect(row?.status).toBe('open');
  });
});

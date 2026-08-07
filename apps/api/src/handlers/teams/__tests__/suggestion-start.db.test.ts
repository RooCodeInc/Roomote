// pnpm --filter @roomote/api test teams/__tests__/suggestion-start.db.test.ts
//
// Real-DB coverage for the Teams "start idea N" resolver: matching the idea
// number against the newest tracked suggestion-card group in the conversation
// (ordered by work_items.sort_order), and claiming the backing work item
// through the shared launch CAS. Mirrors the Telegram claim db test.

import {
  db,
  eq,
  inArray,
  trackedMessages,
  workItems,
} from '@roomote/db/server';

import { resolveAndClaimTeamsSuggestionStart } from '../suggestion-start';

describe('resolveAndClaimTeamsSuggestionStart (work_items launch CAS)', () => {
  const workItemIds: string[] = [];
  const conversationId = `19:teams-conv-${Date.now()}@thread.tacv2`;

  async function seedSuggestionGroup(params: {
    introMessageId: string;
    titles: string[];
    createdAt: Date;
    channelId?: string;
    threadId?: string;
    oneMessagePerSuggestion?: boolean;
  }): Promise<string[]> {
    const channelId = params.channelId ?? conversationId;
    const rows = await db
      .insert(workItems)
      .values(
        params.titles.map((title, index) => ({
          kind: 'suggestion' as const,
          title,
          brief: `${title} brief`,
          sortOrder: index,
          status: 'open' as const,
        })),
      )
      .returning({ id: workItems.id });
    const ids = rows.map((row) => row.id);
    workItemIds.push(...ids);

    await db.insert(trackedMessages).values(
      ids.map((workItemId, index) => ({
        surface: 'teams' as const,
        kind: 'suggestion_card' as const,
        dedupeKey: `${channelId}:${params.introMessageId}:${workItemId}`,
        channelId,
        ...(params.threadId ? { threadTs: params.threadId } : {}),
        messageTs: params.oneMessagePerSuggestion
          ? `${params.introMessageId}-${index + 1}`
          : `${params.introMessageId}:${workItemId}`,
        workItemId,
        createdAt: params.createdAt,
        metadata: {
          suggestionType: 'suggested_tasks',
          suggestionKey: `source-task:${workItemId}`,
          ...(params.oneMessagePerSuggestion
            ? { suggestionGroupKey: 'source-task' }
            : {}),
        },
      })),
    );

    return ids;
  }

  async function readStatus(id: string) {
    const [row] = await db
      .select({
        status: workItems.status,
        launchClaimedAt: workItems.launchClaimedAt,
      })
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return row;
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

  it('returns no_cards when the conversation has no tracked suggestion cards', async () => {
    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId: `19:empty-${Date.now()}@thread.tacv2`,
      ideaNumber: 1,
    });

    expect(resolution).toEqual({ outcome: 'no_cards' });
  });

  it('claims idea N by posted order and returns the fencing token', async () => {
    const [, secondId] = await seedSuggestionGroup({
      introMessageId: 'intro-1',
      titles: ['Idea one', 'Idea two', 'Idea three'],
      createdAt: new Date(),
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 2,
    });

    expect(resolution.outcome).toBe('claimed');

    if (resolution.outcome !== 'claimed') {
      throw new Error('expected claimed');
    }

    expect(resolution.suggestion.id).toBe(secondId);
    expect(resolution.suggestion.title).toBe('Idea two');

    const row = await readStatus(secondId!);
    expect(row?.status).toBe('launching');
    // The returned token is the row's stamped launch_claimed_at.
    expect(resolution.suggestion.launchClaimedAt.getTime()).toBe(
      row?.launchClaimedAt?.getTime(),
    );
  });

  it('does not apply the typed fallback to current-thread reaction cards', async () => {
    await seedSuggestionGroup({
      introMessageId: 'current-thread-card',
      titles: ['Idea one', 'Idea two'],
      createdAt: new Date(),
      oneMessagePerSuggestion: true,
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 2,
    });

    expect(resolution).toEqual({ outcome: 'no_cards' });
  });

  it('returns already_started when the claim CAS loses (double reply)', async () => {
    await seedSuggestionGroup({
      introMessageId: 'intro-1',
      titles: ['Idea one'],
      createdAt: new Date(),
    });

    const first = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 1,
    });
    const second = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 1,
    });

    expect(first.outcome).toBe('claimed');
    expect(second).toEqual({ outcome: 'already_started', title: 'Idea one' });
  });

  it('returns not_found with the idea count when N is out of range', async () => {
    await seedSuggestionGroup({
      introMessageId: 'intro-1',
      titles: ['Idea one', 'Idea two'],
      createdAt: new Date(),
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 5,
    });

    expect(resolution).toEqual({ outcome: 'not_found', ideaCount: 2 });
  });

  it('resolves against the newest suggestion group, not an older post', async () => {
    await seedSuggestionGroup({
      introMessageId: 'intro-old',
      titles: ['Old idea one', 'Old idea two'],
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const [newFirstId] = await seedSuggestionGroup({
      introMessageId: 'intro-new',
      titles: ['New idea one'],
      createdAt: new Date(),
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 1,
    });

    expect(resolution.outcome).toBe('claimed');

    if (resolution.outcome !== 'claimed') {
      throw new Error('expected claimed');
    }

    expect(resolution.suggestion.id).toBe(newFirstId);
    expect(resolution.suggestion.title).toBe('New idea one');

    // Idea 2 exists only in the old group, so against the newest (1-item)
    // group it is out of range rather than a stale-list launch.
    const outOfRange = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      ideaNumber: 2,
    });
    expect(outOfRange).toEqual({ outcome: 'not_found', ideaCount: 1 });
  });

  it('matches a thread-scoped conversation id with a ;messageid= suffix', async () => {
    const [firstId] = await seedSuggestionGroup({
      introMessageId: 'intro-1',
      titles: ['Idea one'],
      createdAt: new Date(),
      threadId: '1751234567890',
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId: `${conversationId};messageid=1751234567890`,
      ideaNumber: 1,
    });

    expect(resolution.outcome).toBe('claimed');

    if (resolution.outcome !== 'claimed') {
      throw new Error('expected claimed');
    }

    expect(resolution.suggestion.id).toBe(firstId);
  });

  it('does not select suggestion cards from another thread', async () => {
    await seedSuggestionGroup({
      introMessageId: 'intro-other',
      titles: ['Other thread idea'],
      createdAt: new Date(),
      threadId: 'thread-other',
    });

    const resolution = await resolveAndClaimTeamsSuggestionStart({
      conversationId,
      threadId: 'thread-current',
      ideaNumber: 1,
    });

    expect(resolution).toEqual({ outcome: 'no_cards' });
  });
});

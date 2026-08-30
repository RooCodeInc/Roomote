import {
  db,
  eq,
  findTrackedSuggestionWorkItemIds,
  registerTrackedSuggestionCards,
  trackedMessages,
  userFactory,
  workItems,
} from '../../server';

describe('tracked suggestion cards', () => {
  it('registers shared card metadata and isolates lookups by surface', async () => {
    const user = await userFactory.create();
    const [workItem] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Investigate retries',
        brief: 'Trace retry exhaustion.',
        sortOrder: 0,
      })
      .returning({ id: workItems.id });

    await registerTrackedSuggestionCards([
      {
        surface: 'slack',
        channelId: 'C123',
        messageTs: '200.001',
        threadTs: '100.001',
        workItemId: workItem!.id,
        createdByUserId: user.id,
        suggestionType: 'suggested_tasks',
        suggestionKey: `event-1:${workItem!.id}`,
        suggestionGroupKey: 'event-1',
        launchRouting: 'router',
      },
    ]);
    await registerTrackedSuggestionCards([
      {
        surface: 'slack',
        channelId: 'C123',
        messageTs: '200.001',
        threadTs: '100.001',
        workItemId: workItem!.id,
        createdByUserId: user.id,
        suggestionType: 'suggested_tasks',
        suggestionKey: `event-1:${workItem!.id}`,
        suggestionGroupKey: 'event-1',
        launchRouting: 'router',
      },
    ]);
    await registerTrackedSuggestionCards([
      {
        surface: 'discord',
        channelId: 'thread-1',
        messageTs: 'message-1',
        threadTs: 'thread-1',
        workItemId: workItem!.id,
        createdByUserId: user.id,
        suggestionType: 'suggested_tasks',
        suggestionKey: `event-1:${workItem!.id}`,
        suggestionGroupKey: 'event-1',
        launchRouting: 'router',
      },
    ]);

    const trackedRows = await db
      .select()
      .from(trackedMessages)
      .where(eq(trackedMessages.workItemId, workItem!.id));
    expect(trackedRows).toHaveLength(2);
    const tracked = trackedRows.find((row) => row.surface === 'slack');
    expect(tracked).toMatchObject({
      surface: 'slack',
      channelId: 'C123',
      messageTs: '200.001',
      threadTs: '100.001',
      createdByUserId: user.id,
      metadata: {
        suggestionType: 'suggested_tasks',
        suggestionKey: `event-1:${workItem!.id}`,
        suggestionGroupKey: 'event-1',
        launchRouting: 'router',
      },
    });
    expect(
      await findTrackedSuggestionWorkItemIds({
        surface: 'slack',
        workItemIds: [workItem!.id],
      }),
    ).toEqual(new Set([workItem!.id]));
    expect(
      await findTrackedSuggestionWorkItemIds({
        surface: 'discord',
        workItemIds: [workItem!.id],
      }),
    ).toEqual(new Set([workItem!.id]));
    expect(
      await findTrackedSuggestionWorkItemIds({
        surface: 'telegram',
        workItemIds: [workItem!.id],
      }),
    ).toEqual(new Set());
  });

  it('handles empty registration and lookup batches', async () => {
    await expect(registerTrackedSuggestionCards([])).resolves.toBeUndefined();
    await expect(
      findTrackedSuggestionWorkItemIds({ surface: 'slack', workItemIds: [] }),
    ).resolves.toEqual(new Set());
  });
});

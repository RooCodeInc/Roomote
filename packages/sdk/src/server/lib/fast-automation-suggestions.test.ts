import {
  and,
  db,
  eq,
  trackedMessages,
  userFactory,
  workItems,
} from '@roomote/db/server';

import {
  appendFastAutomationSuggestionInstruction,
  postFastAutomationSuggestionsToDiscord,
  postFastAutomationSuggestionsToSlack,
} from './fast-automation-suggestions';

describe('Fast automation suggestions', () => {
  it('persists and tracks reaction-launchable Slack suggestion cards idempotently', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn().mockResolvedValue('200.001');
    const suggestion = {
      title: 'Investigate checkout latency',
      brief: 'Trace the slow payment-provider requests.',
    };
    const suggestions = [suggestion];
    const params = {
      slack: { postMessage },
      channelId: 'C123',
      threadTs: '100.001',
      eventId: 'automation-1:2026-08-25T00:00:00.000Z',
      createdByUserId: user.id,
      suggestions,
    };

    await postFastAutomationSuggestionsToSlack(params);
    await postFastAutomationSuggestionsToSlack(params);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        client_msg_id: expect.any(String),
        metadata: expect.objectContaining({
          event_payload: expect.objectContaining({ schemaVersion: 1 }),
        }),
      }),
    );

    const [workItem] = await db
      .select()
      .from(workItems)
      .where(eq(workItems.kind, 'suggestion'));
    expect(workItem).toMatchObject({
      title: suggestion.title,
      brief: suggestion.brief,
      status: 'open',
      sourceTaskId: null,
    });

    const [tracked] = await db
      .select()
      .from(trackedMessages)
      .where(
        and(
          eq(trackedMessages.surface, 'slack'),
          eq(trackedMessages.kind, 'suggestion_card'),
        ),
      );
    expect(tracked).toMatchObject({
      channelId: 'C123',
      messageTs: '200.001',
      threadTs: '100.001',
      workItemId: workItem?.id,
      createdByUserId: user.id,
      metadata: expect.objectContaining({
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      }),
    });
  });

  it('persists and tracks reaction-launchable Discord suggestion cards', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn().mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });

    await postFastAutomationSuggestionsToDiscord({
      provider: { postMessage },
      channelId: 'channel-1',
      threadId: 'thread-1',
      eventId: 'automation-2:2026-08-25T00:00:00.000Z',
      createdByUserId: user.id,
      suggestions: [
        {
          title: 'Verify retry behavior',
          brief: 'Exercise the failed request path.',
        },
      ],
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
        idempotencyKey: expect.stringContaining('fast-automation-suggestion:'),
      }),
    );
    const [tracked] = await db
      .select()
      .from(trackedMessages)
      .where(
        and(
          eq(trackedMessages.surface, 'discord'),
          eq(trackedMessages.kind, 'suggestion_card'),
        ),
      );
    expect(tracked).toMatchObject({
      channelId: 'thread-1',
      messageTs: 'message-1',
      threadTs: 'thread-1',
      createdByUserId: user.id,
      metadata: expect.objectContaining({
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      }),
    });
  });

  it('serializes concurrent persistence retries for one automation event', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn().mockResolvedValue('400.001');
    const params = {
      slack: { postMessage },
      channelId: 'C456',
      threadTs: '300.001',
      eventId: 'automation-3:2026-08-25T00:00:00.000Z',
      createdByUserId: user.id,
      suggestions: [
        {
          title: 'Concurrent persistence check',
          brief: 'Only one work item should be stored.',
        },
      ],
    };

    await Promise.all([
      postFastAutomationSuggestionsToSlack(params),
      postFastAutomationSuggestionsToSlack(params),
    ]);

    const persisted = await db
      .select({ id: workItems.id })
      .from(workItems)
      .where(eq(workItems.title, 'Concurrent persistence check'));
    expect(persisted).toHaveLength(1);
  });

  it('adds launch instructions only when suggestions are present', () => {
    expect(
      appendFastAutomationSuggestionInstruction('Report', 'slack', true),
    ).toContain('React with a :thumbsup:');
    expect(
      appendFastAutomationSuggestionInstruction('Report', 'slack', false),
    ).toBe('Report');
  });
});

import {
  and,
  db,
  eq,
  environmentFactory,
  trackedMessages,
  userFactory,
  workItems,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

import {
  appendFastAutomationSuggestionInstruction,
  postFastAutomationSuggestionsToDiscord,
  postFastAutomationSuggestionsToSlack,
  postFastAutomationSuggestionsToTeams,
  postFastAutomationSuggestionsToTelegram,
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

  it('persists an independent concrete, all-repositories, or Fast target per suggestion', async () => {
    const user = await userFactory.create();
    const environment = await environmentFactory.create({
      createdByUserId: user.id,
      isEval: false,
    });
    let messageSequence = 0;
    const postMessage = vi.fn(async () => `targeted-${++messageSequence}`);

    await postFastAutomationSuggestionsToSlack({
      slack: { postMessage },
      channelId: 'C-targets',
      threadTs: 'targets-root',
      eventId: 'automation-targets',
      createdByUserId: user.id,
      suggestions: [
        {
          title: 'Concrete target',
          brief: 'Run in one environment.',
          environmentId: environment.id,
        },
        {
          title: 'All repositories target',
          brief: 'Run across every repository.',
          environmentId: ALL_REPOSITORIES,
        },
        {
          title: 'Fast target',
          brief: 'Handle this without an initial sandbox.',
          environmentId: FAST_EXECUTION,
        },
      ],
    });

    const persisted = await db
      .select({
        id: workItems.id,
        title: workItems.title,
        targetEnvironmentId: workItems.targetEnvironmentId,
        targetRepositoryFullName: workItems.targetRepositoryFullName,
      })
      .from(workItems);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Concrete target',
          targetEnvironmentId: environment.id,
          targetRepositoryFullName: null,
        }),
        expect.objectContaining({
          title: 'All repositories target',
          targetEnvironmentId: null,
          targetRepositoryFullName: ALL_REPOSITORIES,
        }),
        expect.objectContaining({
          title: 'Fast target',
          targetEnvironmentId: null,
          targetRepositoryFullName: FAST_EXECUTION,
        }),
      ]),
    );

    const tracked = await db
      .select({ metadata: trackedMessages.metadata })
      .from(trackedMessages)
      .where(eq(trackedMessages.surface, 'slack'));
    expect(tracked.map((card) => card.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchTarget: environment.id }),
        expect.objectContaining({ launchTarget: ALL_REPOSITORIES }),
        expect.objectContaining({ launchTarget: FAST_EXECUTION }),
      ]),
    );
    expect(
      tracked
        .filter((card) => card.metadata?.launchTarget)
        .some((card) => card.metadata?.launchRouting === 'router'),
    ).toBe(false);
  });

  it('rejects an unavailable target before posting a suggestion card', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn();

    await expect(
      postFastAutomationSuggestionsToSlack({
        slack: { postMessage },
        channelId: 'C-invalid',
        threadTs: 'invalid-root',
        eventId: 'automation-invalid-target',
        createdByUserId: user.id,
        suggestions: [
          {
            title: 'Invalid target',
            brief: 'This must not launch.',
            environmentId: 'not-an-environment-id',
          },
        ],
      }),
    ).rejects.toThrow('target environment is unavailable');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('rejects a user-scoped environment outside the Fast catalog', async () => {
    const user = await userFactory.create();
    const environment = await environmentFactory.create({
      userId: user.id,
      createdByUserId: user.id,
      isEval: false,
    });
    const postMessage = vi.fn();

    await expect(
      postFastAutomationSuggestionsToSlack({
        slack: { postMessage },
        channelId: 'C-user-scoped',
        threadTs: 'user-scoped-root',
        eventId: 'automation-user-scoped-target',
        createdByUserId: user.id,
        suggestions: [
          {
            title: 'User-scoped target',
            brief: 'This target is not in the shared Fast catalog.',
            environmentId: environment.id,
          },
        ],
      }),
    ).rejects.toThrow('target environment is unavailable');
    expect(postMessage).not.toHaveBeenCalled();
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

  it('persists and tracks reaction-launchable Teams suggestion cards', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn().mockResolvedValue({
      provider: 'teams',
      channelId: 'conversation-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });

    await postFastAutomationSuggestionsToTeams({
      provider: { postMessage },
      channelId: 'conversation-1',
      serviceUrl: 'https://smba.example.com/amer/',
      threadId: 'thread-1',
      eventId: 'automation-teams',
      createdByUserId: user.id,
      suggestions: [
        { title: 'Verify Teams retries', brief: 'Exercise the failure path.' },
      ],
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'conversation-1',
        serviceUrl: 'https://smba.example.com/amer/',
        threadId: 'thread-1',
      }),
    );
    const [tracked] = await db
      .select()
      .from(trackedMessages)
      .where(eq(trackedMessages.surface, 'teams'));
    expect(tracked).toMatchObject({
      channelId: 'conversation-1',
      messageTs: 'message-1',
      threadTs: 'thread-1',
      createdByUserId: user.id,
      metadata: expect.objectContaining({ launchRouting: 'router' }),
    });
  });

  it('persists and tracks button-launchable Telegram suggestion cards', async () => {
    const user = await userFactory.create();
    const postMessage = vi.fn().mockResolvedValue({
      provider: 'telegram',
      channelId: 'chat-1',
      messageId: 'message-1',
    });

    await postFastAutomationSuggestionsToTelegram({
      provider: { postMessage },
      channelId: 'chat-1',
      eventId: 'automation-telegram',
      createdByUserId: user.id,
      suggestions: [
        {
          title: 'Verify Telegram retries',
          brief: 'Exercise the failure path.',
        },
      ],
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chat-1',
        buttons: [
          [
            {
              text: 'Start',
              callbackData: expect.stringMatching(/^idea:/),
            },
          ],
        ],
      }),
    );
    const [tracked] = await db
      .select()
      .from(trackedMessages)
      .where(eq(trackedMessages.surface, 'telegram'));
    expect(tracked).toMatchObject({
      channelId: 'chat-1',
      messageTs: 'message-1',
      createdByUserId: user.id,
      metadata: expect.objectContaining({ launchRouting: 'router' }),
    });
  });

  it.each([
    {
      surface: 'teams' as const,
      post: postFastAutomationSuggestionsToTeams,
      providerResult: {
        provider: 'teams' as const,
        channelId: 'conversation-retry',
        messageId: 'teams-message-retry',
      },
      extra: {
        serviceUrl: 'https://smba.example.com/amer/',
      },
    },
    {
      surface: 'telegram' as const,
      post: postFastAutomationSuggestionsToTelegram,
      providerResult: {
        provider: 'telegram' as const,
        channelId: 'conversation-retry',
        messageId: 'telegram-message-retry',
      },
      extra: {},
    },
  ])(
    'does not duplicate $surface cards when the provider outcome is unknown',
    async ({ post, providerResult, extra }) => {
      const user = await userFactory.create();
      const postMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error('provider response lost'))
        .mockResolvedValue(providerResult);
      const params = {
        provider: { postMessage },
        channelId: 'conversation-retry',
        eventId: `automation-retry-${providerResult.provider}`,
        createdByUserId: user.id,
        suggestions: [
          {
            title: 'Retry-safe delivery',
            brief: 'Do not post this card twice.',
          },
        ],
        ...extra,
      };

      await expect(post(params as never)).rejects.toThrow(
        'provider response lost',
      );
      await post(params as never);

      expect(postMessage).toHaveBeenCalledOnce();
      const [claim] = await db
        .select()
        .from(trackedMessages)
        .where(
          and(
            eq(trackedMessages.surface, providerResult.provider),
            eq(trackedMessages.channelId, 'conversation-retry'),
          ),
        );
      expect(claim).toMatchObject({
        channelId: 'conversation-retry',
        messageTs: null,
        createdByUserId: user.id,
        metadata: expect.objectContaining({ launchRouting: 'router' }),
      });
    },
  );

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
    expect(
      appendFastAutomationSuggestionInstruction('Report', 'telegram', true),
    ).toContain('Tap Start');
  });
});

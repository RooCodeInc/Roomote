import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildRowsMock,
  claimWorkItemMock,
  createTaskThreadMock,
  enqueueFollowupMock,
  findDestinationMock,
  findTrackedCardMock,
  hasTrackedMock,
  insertRowsMock,
  resolveProviderMock,
  scheduleFollowupMock,
} = vi.hoisted(() => ({
  buildRowsMock: vi.fn(),
  claimWorkItemMock: vi.fn(),
  createTaskThreadMock: vi.fn(),
  enqueueFollowupMock: vi.fn(),
  findDestinationMock: vi.fn(),
  findTrackedCardMock: vi.fn(),
  hasTrackedMock: vi.fn(),
  insertRowsMock: vi.fn(),
  resolveProviderMock: vi.fn(),
  scheduleFollowupMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...values: unknown[]) => values),
  eq: vi.fn((...values: unknown[]) => values),
  claimWorkItem: claimWorkItemMock,
  trackedMessages: {
    surface: 'surface',
    kind: 'kind',
    channelId: 'channelId',
    workItemId: 'workItemId',
  },
  db: {
    query: {
      trackedMessages: { findFirst: findTrackedCardMock },
    },
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueDiscordSuggestedTasksOnboardingFollowup: enqueueFollowupMock,
  findDiscordDefaultDestination: findDestinationMock,
}));

vi.mock('../../tasks/setup-suggestion-lifecycle.js', () => ({
  MAX_SETUP_SUGGESTIONS: 5,
  buildInlineSuggestionIdeaLines: vi.fn(() => [
    '**1. Fix tests**\nRepair the flaky test.',
  ]),
  buildSharedMessageSuggestionRows: buildRowsMock,
  hasTrackedSetupSuggestionMessages: hasTrackedMock,
  insertSetupSuggestionMessageRows: insertRowsMock,
  scheduleSuggestedTasksFollowupBestEffort: scheduleFollowupMock,
}));

vi.mock('../../tasks/communication-task-thread.js', () => ({
  buildCommunicationTaskThreadName: vi.fn((value: string) => value),
}));

vi.mock('../provider.js', () => ({
  resolveDiscordProvider: resolveProviderMock,
}));

import {
  claimDiscordSuggestionLaunch,
  postSetupTaskSuggestionsToDiscord,
} from '../setup-suggestions';

describe('Discord setup suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDestinationMock.mockResolvedValue({
      guildId: 'guild-1',
      channelId: 'channel-1',
      channelType: 0,
    });
    hasTrackedMock.mockResolvedValue(false);
    createTaskThreadMock.mockResolvedValue({
      channelId: 'thread-1',
      parentChannelId: 'channel-1',
      messageId: 'message-1',
      kind: 'thread',
      name: 'Suggested tasks',
    });
    resolveProviderMock.mockResolvedValue({
      provider: { createTaskThread: createTaskThreadMock },
    });
    buildRowsMock.mockReturnValue([{ id: 'tracked-1' }]);
    enqueueFollowupMock.mockResolvedValue({ enqueued: true, jobId: 'job-1' });
    scheduleFollowupMock.mockImplementation(
      async ({ enqueue }: { enqueue: () => Promise<unknown> }) => enqueue(),
    );
    findTrackedCardMock.mockResolvedValue({ id: 'tracked-1' });
    claimWorkItemMock.mockResolvedValue({
      id: 'suggestion-1',
      title: 'Fix tests',
      brief: 'Repair the flaky test.',
      investigationContext: null,
      targetRepositoryFullName: 'owner/repo',
      launchClaimedAt: new Date('2026-07-12T12:00:00.000Z'),
    });
  });

  it('posts one thread with launch buttons and tracks the thread channel', async () => {
    const delivered = await postSetupTaskSuggestionsToDiscord({
      sourceTaskId: 'setup-task-1',
      createdByUserId: 'user-1',
      suggestions: [
        { id: 'suggestion-1', title: 'Fix tests', brief: 'Repair it.' },
      ],
    });

    expect(delivered).toBe(true);
    expect(createTaskThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        name: 'Suggested tasks',
        buttons: [
          [
            {
              text: '▶️ Start idea 1',
              callbackData: 'idea:suggestion-1',
            },
          ],
        ],
      }),
    );
    expect(buildRowsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'discord',
        messageId: 'message-1',
        channelId: 'thread-1',
      }),
    );
    expect(insertRowsMock).toHaveBeenCalledWith([{ id: 'tracked-1' }]);
    expect(enqueueFollowupMock).toHaveBeenCalledWith({
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      introMessageId: 'message-1',
      sourceTaskId: 'setup-task-1',
    });
  });

  it('requires the button to belong to the current Discord thread', async () => {
    const claim = await claimDiscordSuggestionLaunch({
      suggestionId: 'suggestion-1',
      channelId: 'thread-1',
    });

    expect(findTrackedCardMock).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { id: true } }),
    );
    expect(claimWorkItemMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'suggestion-1',
    });
    expect(claim).toMatchObject({
      id: 'suggestion-1',
      targetRepositoryFullName: 'owner/repo',
    });

    findTrackedCardMock.mockResolvedValueOnce(null);
    await expect(
      claimDiscordSuggestionLaunch({
        suggestionId: 'suggestion-1',
        channelId: 'different-thread',
      }),
    ).resolves.toBeNull();
  });
});

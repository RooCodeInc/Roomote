import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimWorkItem: vi.fn(),
  finalizeWorkItemLaunched: vi.fn(),
  releaseWorkItemClaim: vi.fn(),
  trackedMessageFindFirst: vi.fn(),
  resolveWorkspace: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  startAutoRoutedSlackTask: vi.fn(),
  startSlackAppMentionTask: vi.fn(),
  startFastAgentResponse: vi.fn(),
  postStartedMessage: vi.fn(),
  getConfiguration: vi.fn(),
}));

const claimedAt = new Date('2026-08-06T00:00:00.000Z');
const workItem = {
  id: 'work-item-1',
  title: 'Add retry telemetry',
  brief: 'Instrument retry exhaustion.',
  category: 'improvement',
  priority: 'P2',
  investigationContext: 'Inspect the retry handler.',
  repositoryIds: ['repo-1'],
  targetRepositoryFullName: 'acme/app',
  targetEnvironmentId: 'environment-1',
  readinessMessage: null,
  sortOrder: 0,
  status: 'open',
};

function createWorkItemSelectBuilder() {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve([workItem]),
  };
  return builder;
}

const updateBuilder = {
  set: vi.fn(() => updateBuilder),
  where: vi.fn(async () => undefined),
};

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => args),
  eq: vi.fn((...args) => args),
  trackedMessages: {
    id: 'id',
    kind: 'kind',
    channelId: 'channelId',
    messageTs: 'messageTs',
    workItemId: 'workItemId',
  },
  workItems: {
    id: 'id',
    title: 'title',
    brief: 'brief',
    category: 'category',
    priority: 'priority',
    investigationContext: 'investigationContext',
    repositoryIds: 'repositoryIds',
    targetRepositoryFullName: 'targetRepositoryFullName',
    targetEnvironmentId: 'targetEnvironmentId',
    readinessMessage: 'readinessMessage',
    sortOrder: 'sortOrder',
    status: 'status',
  },
  claimWorkItem: mocks.claimWorkItem,
  finalizeWorkItemLaunched: mocks.finalizeWorkItemLaunched,
  releaseWorkItemClaim: mocks.releaseWorkItemClaim,
  db: {
    query: {
      trackedMessages: { findFirst: mocks.trackedMessageFindFirst },
      deploymentSettings: { findFirst: vi.fn() },
    },
    select: () => createWorkItemSelectBuilder(),
    update: () => updateBuilder,
  },
}));

vi.mock('@roomote/slack', () => ({
  resolveSlackReactionNames: vi.fn(async () => ({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
  })),
  startAutoRoutedSlackTask: mocks.startAutoRoutedSlackTask,
  startSlackAppMentionTask: mocks.startSlackAppMentionTask,
}));

vi.mock('../helpers/suggestion-workspace.js', () => ({
  buildSeededSuggestionSlackText: vi.fn(() => 'seeded suggestion'),
  buildSuggestionBadgePrefix: vi.fn(() => ''),
  buildSuggestionSlackText: vi.fn(() => 'suggestion text'),
  buildSuggestionTaskPromptText: vi.fn(() => 'implementation prompt'),
  findMatchingEnvironmentIdForRepositoryIds: vi.fn(),
  parseSetupSuggestionIdFromSlackMessageMetadata: vi.fn(),
  repositoryIdsMatchSelection: vi.fn(),
  resolveSuggestionLaunchWorkspaceFromMetadata: mocks.resolveWorkspace,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postTaskSuggestionStartedMessage: mocks.postStartedMessage,
}));

vi.mock('../../call-roomote-via-emoji.js', () => ({
  getCallRoomoteViaEmojiConfiguration: mocks.getConfiguration,
}));

vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: vi.fn(),
}));

vi.mock('./message-entry.js', () => ({
  handleMessageOrAppMentionEvent: vi.fn(),
  startFastAgentResponse: mocks.startFastAgentResponse,
}));

vi.mock('./task-suggestion-reaction-contention.js', () => ({
  runTaskSuggestionReactionContention: vi.fn(
    async ({ launch }: { launch: () => Promise<boolean> }) =>
      (await launch()) ? 'handled' : 'cleared',
  ),
}));

import { handleReactionAddedEvent } from './reactions';

describe('chat reply suggestion reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockResolvedValue(null);
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: { suggestionType: 'suggested_tasks', launchRouting: 'router' },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: null,
    });
    mocks.claimWorkItem.mockResolvedValue({ launchClaimedAt: claimedAt });
    mocks.finalizeWorkItemLaunched.mockResolvedValue(true);
    mocks.releaseWorkItemClaim.mockResolvedValue(true);
    mocks.postStartedMessage.mockResolvedValue(undefined);
    mocks.resolveWorkspace.mockResolvedValue({
      workspace: {
        repoForPayload: 'acme/app',
        environmentId: 'environment-1',
        workspaceDisplayName: 'Acme',
      },
      failureReason: null,
    });
    mocks.startAutoRoutedSlackTask.mockResolvedValue({
      status: 'started',
      threadId: 'seeded-thread-ts',
      runId: 42,
      taskId: 'task-new',
    });
    mocks.startSlackAppMentionTask.mockResolvedValue({
      id: 42,
      taskId: 'task-new',
    });
    mocks.startFastAgentResponse.mockResolvedValue({ accepted: true });
  });

  it('starts and records a coding task when Fast is unavailable', async () => {
    const slack = {
      postMessage: vi.fn(async () => 'seeded-thread-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.startAutoRoutedSlackTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        prompt:
          'Start this suggested task: Add retry telemetry\n\nInstrument retry exhaustion.',
        agentPromptTextOverride: 'implementation prompt',
      }),
    );
    expect(mocks.startSlackAppMentionTask).not.toHaveBeenCalled();
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'work-item-1',
        taskId: 'task-new',
        claimedAt,
      },
    );
    expect(mocks.postStartedMessage).not.toHaveBeenCalled();
  });

  it('keeps a finalized launch when tracked thread bookkeeping fails', async () => {
    updateBuilder.where.mockRejectedValueOnce(new Error('tracking failed'));
    const slack = {
      postMessage: vi.fn(async () => 'seeded-thread-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'work-item-1', taskId: 'task-new', claimedAt },
    );
    expect(mocks.releaseWorkItemClaim).not.toHaveBeenCalled();
    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('starts a Fast session when Fast is the user default', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: {
        userId: 'user-1',
      },
    });
    const slack = {
      postMessage: vi.fn(async () => 'seeded-thread-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.startFastAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: true,
        userId: 'user-1',
        event: expect.objectContaining({
          channel: 'C1',
          thread_ts: 'seeded-thread-ts',
          agentContext: 'implementation prompt',
        }),
      }),
    );
    expect(mocks.startAutoRoutedSlackTask).not.toHaveBeenCalled();
    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'work-item-1', taskId: null, claimedAt },
    );
  });

  it('releases the claim when the Fast turn lock is busy', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: {
        userId: 'user-1',
      },
    });
    mocks.startFastAgentResponse.mockResolvedValue({
      accepted: false,
      reason: 'Fast session is busy.',
    });
    const slack = {
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('seeded-thread-ts')
        .mockResolvedValueOnce('failure-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.releaseWorkItemClaim).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt,
    });
    expect(mocks.finalizeWorkItemLaunched).not.toHaveBeenCalled();
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'seeded-thread-ts',
    });
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('busy') }),
    );
  });

  it('releases the claim when Fast startup fails before acceptance', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: {
        userId: 'user-1',
      },
    });
    mocks.startFastAgentResponse.mockRejectedValue(
      new Error('Fast startup failed'),
    );
    const slack = {
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('seeded-thread-ts')
        .mockResolvedValueOnce('failure-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.releaseWorkItemClaim).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt,
    });
    expect(mocks.finalizeWorkItemLaunched).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Fast startup failed'),
      }),
    );
  });

  it('releases the suggestion when routing cannot choose a workspace', async () => {
    mocks.startAutoRoutedSlackTask.mockResolvedValue({
      status: 'not_started',
      code: 'routing_fallback',
      threadId: 'seeded-thread-ts',
      message: 'Slack auto-routing needs manual environment selection.',
    });
    const slack = {
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('seeded-thread-ts')
        .mockResolvedValueOnce('failure-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.releaseWorkItemClaim).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt,
    });
    expect(mocks.finalizeWorkItemLaunched).not.toHaveBeenCalled();
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'seeded-thread-ts',
    });
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: 'C1',
        text: expect.stringContaining(
          'Slack auto-routing needs manual environment selection.',
        ),
      }),
    );
  });

  it('keeps unmarked suggestion cards pinned to their verified workspace', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: { suggestionType: 'suggested_tasks' },
    });
    const slack = {
      postMessage: vi.fn(async () => 'seeded-thread-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: 'card-ts' },
        event_ts: 'event-ts',
      },
    });

    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      targetRepositoryFullName: 'acme/app',
      targetEnvironmentId: 'environment-1',
      readinessMessage: null,
    });
    expect(mocks.startSlackAppMentionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/app',
        environmentId: 'environment-1',
      }),
    );
    expect(mocks.startAutoRoutedSlackTask).not.toHaveBeenCalled();
  });
});

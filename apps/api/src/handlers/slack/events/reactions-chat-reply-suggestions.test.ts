import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimWorkItem: vi.fn(),
  finalizeWorkItemLaunched: vi.fn(),
  releaseWorkItemClaim: vi.fn(),
  trackedMessageFindFirst: vi.fn(),
  resolveWorkspace: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  startSlackAppMentionTask: vi.fn(),
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
      metadata: { suggestionType: 'suggested_tasks' },
    });
    mocks.resolveWorkspace.mockResolvedValue({
      workspace: {
        repoForPayload: 'acme/app',
        environmentId: 'environment-1',
        workspaceDisplayName: 'Acme',
      },
      failureReason: null,
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    mocks.claimWorkItem.mockResolvedValue({ launchClaimedAt: claimedAt });
    mocks.finalizeWorkItemLaunched.mockResolvedValue(true);
    mocks.startSlackAppMentionTask.mockResolvedValue({
      id: 42,
      taskId: 'task-new',
    });
  });

  it('starts and records a task when a user approves a chat reply suggestion', async () => {
    const slack = {
      postMessage: vi.fn(async () => 'seeded-thread-ts'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE' },
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
        channel: 'C1',
        repo: 'acme/app',
        environmentId: 'environment-1',
        agentPromptText: 'implementation prompt',
      }),
    );
    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'work-item-1',
        taskId: 'task-new',
        claimedAt,
      },
    );
    expect(mocks.postStartedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C1',
        threadTs: 'seeded-thread-ts',
        taskId: 'task-new',
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  claimWorkItem: vi.fn(),
  finalizeWorkItemLaunched: vi.fn(),
  releaseWorkItemClaim: vi.fn(),
  trackedMessageFindFirst: vi.fn(),
  resolveWorkspace: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  launchPinned: vi.fn(),
  liveTaskLauncher: vi.fn(),
  launchTask: vi.fn(),
  startFastAgentResponse: vi.fn(),
  postStartedMessage: vi.fn(),
  getConfiguration: vi.fn(),
  routeFastReaction: vi.fn(),
}));

const claimedAt = new Date('2026-08-06T00:00:00.000Z');
const workItem: {
  id: string;
  title: string;
  brief: string;
  category: string;
  priority: string;
  investigationContext: string;
  repositoryIds: string[];
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  readinessMessage: null;
  sortOrder: number;
  status: string;
} = {
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
  createFastAgentSlackLiveTaskLauncher: mocks.liveTaskLauncher,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  launchPinnedFastSessionTask: mocks.launchPinned,
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

vi.mock('./fast-agent-reaction.js', () => ({
  maybeRouteFastAgentReaction: mocks.routeFastReaction,
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
    workItem.targetRepositoryFullName = 'acme/app';
    workItem.targetEnvironmentId = 'environment-1';
    mocks.routeFastReaction.mockResolvedValue(false);
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
    mocks.launchTask.mockResolvedValue({
      success: true,
      taskId: 'task-new',
      taskUrl: 'https://roomote.example/task/task-new',
    });
    mocks.liveTaskLauncher.mockReturnValue(mocks.launchTask);
    // The pinned-launch primitive runs the surface launcher inside a Session.
    mocks.launchPinned.mockImplementation(
      async (input: {
        launchId: string;
        conversation: unknown;
        launch: (context: {
          parent: { sessionId: string; conversation: unknown };
          launchIdempotencyKey: string;
          postKickoff: () => Promise<void>;
        }) => Promise<
          { success: true; taskId: string } | { success: false; error: string }
        >;
      }) => {
        const result = await input.launch({
          parent: { sessionId: 'fast-1', conversation: input.conversation },
          launchIdempotencyKey: `pinned-launch:${input.launchId}`,
          postKickoff: async () => {},
        });
        if (!result.success) throw new Error(result.error);
        return {
          sessionId: 'session-1',
          fastConversationId: 'fast-1',
          taskId: result.taskId,
          runId: 42,
        };
      },
    );
    mocks.startFastAgentResponse.mockResolvedValue({ accepted: true });
  });

  it('prompts an unlinked reactor to link before a router-backed suggestion', async () => {
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

    // Router cards let Fast decide, and Fast needs a linked person.
    expect(mocks.claimWorkItem).not.toHaveBeenCalled();
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
    expect(mocks.launchPinned).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('linked Roomote account'),
      }),
    );
    expect(mocks.routeFastReaction).not.toHaveBeenCalled();
  });

  it('keeps a finalized launch when tracked thread bookkeeping fails', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: { suggestionType: 'suggested_tasks' },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
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
    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'work-item-1', taskId: null, claimedAt },
    );
  });

  it('launches a pinned automation suggestion through the owning Session without a Fast turn', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: { suggestionType: 'suggested_tasks' },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
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

    expect(mocks.resolveWorkspace).toHaveBeenCalled();
    expect(mocks.launchPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        surface: 'slack',
        conversation: {
          surface: 'slack',
          workspaceId: 'T1',
          conversationId: 'seeded-thread-ts',
          replyTarget: { channelId: 'C1', threadId: 'seeded-thread-ts' },
        },
        kickoffMessage: 'Started a task in Acme.',
      }),
    );
    expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        teamId: 'T1',
        channelId: 'C1',
        threadTs: 'seeded-thread-ts',
        repoForPayload: 'acme/app',
      }),
    );
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'implementation prompt',
        environmentId: 'environment-1',
        parentSessionId: 'fast-1',
      }),
    );
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
    expect(mocks.finalizeWorkItemLaunched).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'work-item-1', taskId: 'task-new', claimedAt },
    );
    expect(mocks.postStartedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceName: 'Acme', taskId: 'task-new' }),
    );
  });

  it('forces a concrete suggestion target to coding even when Fast is the user default', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchTarget: 'environment-1',
      },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
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

    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnvironmentId: 'environment-1' }),
    );
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1' }),
    );
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
  });

  it('launches an all-repositories suggestion through the Session without routing', async () => {
    workItem.targetRepositoryFullName = ALL_REPOSITORIES;
    workItem.targetEnvironmentId = null;
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchTarget: ALL_REPOSITORIES,
      },
    });
    mocks.resolveWorkspace.mockResolvedValue({
      workspace: {
        repoForPayload: ALL_REPOSITORIES,
        workspaceDisplayName: 'all repositories',
      },
      failureReason: null,
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

    expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ repoForPayload: ALL_REPOSITORIES }),
    );
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: null }),
    );
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
  });

  it('reports an explicit environment target as unavailable after its column was cleared', async () => {
    // The environment FK nulled the work item's column when the environment
    // was deleted; the card still names it, so the resolver must be asked
    // about that environment rather than reporting "no target repository".
    workItem.targetRepositoryFullName = null;
    workItem.targetEnvironmentId = null;
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchTarget: 'environment-1',
      },
    });
    mocks.resolveWorkspace.mockResolvedValue({
      workspace: null,
      failureReason:
        "I couldn't start this suggestion because its environment is no longer available.",
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

    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnvironmentId: 'environment-1' }),
    );
    expect(mocks.releaseWorkItemClaim).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt,
    });
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('no longer available'),
      }),
    );
  });

  it('prompts an unlinked reactor to link before starting a Fast-targeted suggestion', async () => {
    workItem.targetRepositoryFullName = FAST_EXECUTION;
    workItem.targetEnvironmentId = null;
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchTarget: FAST_EXECUTION,
      },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: null,
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

    // No claim, no seeded thread, no launch of any kind: just the link prompt.
    expect(mocks.claimWorkItem).not.toHaveBeenCalled();
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('linked Roomote account'),
      }),
    );
    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('forces a Fast-targeted suggestion into a Fast session', async () => {
    workItem.targetRepositoryFullName = FAST_EXECUTION;
    workItem.targetEnvironmentId = null;
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchTarget: FAST_EXECUTION,
      },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
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

    expect(mocks.startFastAgentResponse).toHaveBeenCalled();
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
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

  it('keeps unmarked suggestion cards pinned to their verified workspace', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      metadata: { suggestionType: 'suggested_tasks' },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
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
    expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ repoForPayload: 'acme/app' }),
    );
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-1' }),
    );
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
  });
});

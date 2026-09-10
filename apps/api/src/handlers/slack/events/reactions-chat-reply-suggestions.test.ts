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
  getSessionForTask: vi.fn(),
  sessionsFindFirst: vi.fn(),
  conversationFindById: vi.fn(),
  conversationGetOrCreate: vi.fn(),
  parseSuggestionMetadata: vi.fn(),
  liveTaskLauncher: vi.fn(),
  launchTask: vi.fn(),
  startFastAgentResponse: vi.fn(),
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
  sourceTaskId: string | null;
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
  sourceTaskId: 'scan-task-1',
};

function createWorkItemSelectBuilder() {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve([workItem]),
  };
  return builder;
}

let updateBuilderCatchError: Error | null = null;
const updateBuilder = {
  set: vi.fn(() => updateBuilder),
  where: vi.fn(() => updateBuilder),
  returning: vi.fn(async () => [{ id: 'tracked-message-1' }]),
  then: <TResult1 = undefined, TResult2 = never>(
    onfulfilled?:
      | ((value: undefined) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise.resolve(undefined).then(onfulfilled, onrejected),
  catch: vi.fn(
    async (onRejected?: (reason: unknown) => unknown): Promise<unknown> => {
      const error = updateBuilderCatchError;
      updateBuilderCatchError = null;
      return error ? onRejected?.(error) : undefined;
    },
  ),
};

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => args),
  eq: vi.fn((...args) => args),
  sql: vi.fn((strings, ...values) => ['sql', strings, values]),
  trackedMessages: {
    id: 'id',
    surface: 'surface',
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
    sourceTaskId: 'sourceTaskId',
    launchClaimedAt: 'launchClaimedAt',
  },
  claimWorkItem: mocks.claimWorkItem,
  getSessionForTask: mocks.getSessionForTask,
  finalizeWorkItemLaunched: mocks.finalizeWorkItemLaunched,
  releaseWorkItemClaim: mocks.releaseWorkItemClaim,
  sessions: { id: 'sessions.id' },
  db: {
    query: {
      trackedMessages: { findFirst: mocks.trackedMessageFindFirst },
      deploymentSettings: { findFirst: vi.fn() },
      sessions: { findFirst: mocks.sessionsFindFirst },
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
  fastAgentConversationRepository: {
    findById: mocks.conversationFindById,
    getOrCreate: mocks.conversationGetOrCreate,
  },
}));

vi.mock('../helpers/suggestion-workspace.js', () => ({
  buildSeededSuggestionSlackText: vi.fn(() => 'seeded suggestion'),
  buildSuggestionBadgePrefix: vi.fn(() => ''),
  buildSuggestionSlackText: vi.fn(() => 'suggestion text'),
  buildSuggestionTaskPromptText: vi.fn(() => 'implementation prompt'),
  findMatchingEnvironmentIdForRepositoryIds: vi.fn(),
  parseSetupSuggestionIdFromSlackMessageMetadata: mocks.parseSuggestionMetadata,
  repositoryIdsMatchSelection: vi.fn(),
  resolveSuggestionLaunchWorkspaceFromMetadata: mocks.resolveWorkspace,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
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
    updateBuilderCatchError = null;
    mocks.getSessionForTask.mockResolvedValue(null);
    mocks.sessionsFindFirst.mockResolvedValue(null);
    mocks.conversationFindById.mockResolvedValue(null);
    mocks.parseSuggestionMetadata.mockReturnValue(null);
    mocks.getConfiguration.mockResolvedValue(null);
    workItem.targetRepositoryFullName = 'acme/app';
    workItem.sourceTaskId = 'scan-task-1';
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

  it.each([{ cardChannel: 'C1' }, { cardChannel: 'C_OTHER' }])(
    'does not route from metadata fallback card $cardChannel',
    async ({ cardChannel }) => {
      mocks.parseSuggestionMetadata.mockReturnValue('work-item-1');
      mocks.trackedMessageFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'tracked-message-1',
          workItemId: 'work-item-1',
          surface: 'slack',
          channelId: cardChannel,
          threadTs: 'report-thread-ts',
          metadata: { suggestionType: 'suggested_tasks' },
        });
      mocks.lookupSlackUserMapping.mockResolvedValue({
        hasInactiveMapping: false,
        activeMapping: { userId: 'user-1' },
      });
      const slack = {
        postMessage: vi.fn(
          async (_input: { channel: string; thread_ts?: string }) =>
            'announce-ts',
        ),
        deleteMessage: vi.fn(),
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
          item: { type: 'message', channel: 'C1', ts: 'forwarded-card-ts' },
          event_ts: 'event-ts',
        },
      });
      expect(
        mocks.trackedMessageFindFirst.mock.calls[1]![0].where,
      ).toContainEqual(['surface', 'slack']);
      expect(slack.postMessage.mock.calls[0]![0]).toMatchObject({
        channel: 'C1',
      });
      expect(slack.postMessage.mock.calls[0]![0]).not.toHaveProperty(
        'thread_ts',
      );
      expect(mocks.launchPinned).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: {
            surface: 'slack',
            workspaceId: 'T1',
            conversationId: 'announce-ts',
            replyTarget: {
              channelId: 'C1',
              threadId: 'announce-ts',
            },
          },
        }),
      );
      expect(updateBuilder.where).toHaveBeenCalledWith([
        ['id', 'tracked-message-1'],
        ['surface', 'slack'],
        ['channelId', cardChannel],
      ]);
    },
  );

  it('does not launch a metadata fallback without a Slack card', async () => {
    mocks.parseSuggestionMetadata.mockReturnValue('work-item-1');
    mocks.trackedMessageFindFirst.mockResolvedValue(null);
    const slack = { getMessageMetadata: vi.fn(), postMessage: vi.fn() };
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
    for (const [query] of mocks.trackedMessageFindFirst.mock.calls) {
      expect(query.where).toContainEqual(['surface', 'slack']);
    }
    expect(mocks.claimWorkItem).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
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
    updateBuilderCatchError = new Error('tracking failed');
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

  it.each(['router', 'pinned'])(
    'starts a %s suggestion in its own thread and Session while retaining origin metadata',
    async (launchKind) => {
      mocks.trackedMessageFindFirst.mockResolvedValue({
        id: 'tracked-message-1',
        workItemId: 'work-item-1',
        channelId: 'C1',
        metadata: {
          suggestionType: 'suggested_tasks',
          originSessionId: 'session-origin',
          ...(launchKind === 'router' ? { launchRouting: 'router' } : {}),
        },
      });
      mocks.lookupSlackUserMapping.mockResolvedValue({
        hasInactiveMapping: false,
        activeMapping: { userId: 'user-1' },
      });
      const slack = {
        postMessage: vi.fn(async () => 'execution-thread-ts'),
        deleteMessage: vi.fn(async () => undefined),
        addReaction: vi.fn(async () => true),
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

      expect(slack.postMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ thread_ts: expect.anything() }),
      );
      expect(slack.addReaction).toHaveBeenCalledWith({
        channel: 'C1',
        timestamp: 'card-ts',
        name: 'eyes',
      });
      expect(mocks.getSessionForTask).not.toHaveBeenCalled();
      expect(mocks.conversationGetOrCreate).not.toHaveBeenCalled();
      expect(updateBuilder.set).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          metadata: expect.objectContaining({
            originSessionId: 'session-origin',
            executionChannelId: 'C1',
            executionThreadTs: 'execution-thread-ts',
            executionClaimedAt: claimedAt.toISOString(),
          }),
        }),
      );
      expect(updateBuilder.set).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadTs: 'execution-thread-ts' }),
      );

      if (launchKind === 'router') {
        expect(mocks.startFastAgentResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            event: expect.objectContaining({
              channel: 'C1',
              ts: 'execution-thread-ts',
              thread_ts: 'execution-thread-ts',
            }),
          }),
        );
      } else {
        expect(mocks.launchPinned).toHaveBeenCalledWith(
          expect.objectContaining({
            launchId: 'slack-suggestion:work-item-1',
            conversation: {
              surface: 'slack',
              workspaceId: 'T1',
              conversationId: 'execution-thread-ts',
              replyTarget: {
                channelId: 'C1',
                threadId: 'execution-thread-ts',
              },
            },
          }),
        );
        expect(mocks.launchPinned.mock.calls[0]![0]).not.toHaveProperty(
          'originSessionId',
        );
        expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
          expect.objectContaining({
            channelId: 'C1',
            threadTs: 'execution-thread-ts',
            messageId: 'execution-thread-ts',
          }),
        );
      }
    },
  );

  it('reuses a persisted execution thread on an acceptance retry', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      channelId: 'C1',
      metadata: {
        suggestionType: 'suggested_tasks',
        executionChannelId: 'C1',
        executionThreadTs: 'existing-execution-thread-ts',
      },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    const slack = {
      postMessage: vi.fn(),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => true),
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

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(mocks.launchPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        launchId: 'slack-suggestion:work-item-1',
        conversation: expect.objectContaining({
          conversationId: 'existing-execution-thread-ts',
          replyTarget: {
            channelId: 'C1',
            threadId: 'existing-execution-thread-ts',
          },
        }),
      }),
    );
  });

  it('does not create an execution thread when acknowledgement fails', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      channelId: 'C1',
      metadata: { suggestionType: 'suggested_tasks' },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    const slack = {
      postMessage: vi.fn(),
      deleteMessage: vi.fn(),
      addReaction: vi.fn(async () => false),
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

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
    expect(mocks.launchPinned).not.toHaveBeenCalled();
    expect(mocks.releaseWorkItemClaim).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt,
    });
  });

  it('does not delete an execution root after a newer claim takes ownership', async () => {
    mocks.trackedMessageFindFirst.mockResolvedValue({
      id: 'tracked-message-1',
      workItemId: 'work-item-1',
      channelId: 'C1',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      },
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    mocks.startFastAgentResponse.mockRejectedValue(new Error('startup failed'));
    updateBuilder.returning
      .mockResolvedValueOnce([{ id: 'tracked-message-1' }])
      .mockResolvedValueOnce([]);
    const slack = {
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('execution-thread-ts')
        .mockResolvedValueOnce('failure-message-ts'),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => true),
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

    expect(updateBuilder.returning).toHaveBeenCalledTimes(2);
    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('gives two accepted suggestions from one origin separate execution threads', async () => {
    mocks.trackedMessageFindFirst
      .mockResolvedValueOnce({
        id: 'tracked-message-1',
        workItemId: 'work-item-1',
        channelId: 'C1',
        metadata: {
          suggestionType: 'suggested_tasks',
          launchRouting: 'router',
          originSessionId: 'session-origin',
        },
      })
      .mockResolvedValueOnce({
        id: 'tracked-message-2',
        workItemId: 'work-item-2',
        channelId: 'C1',
        metadata: {
          suggestionType: 'suggested_tasks',
          launchRouting: 'router',
          originSessionId: 'session-origin',
        },
      });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    const slack = {
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('execution-thread-1')
        .mockResolvedValueOnce('execution-thread-2'),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => true),
      getMessageMetadata: vi.fn(),
    };
    const context = {
      teamId: 'T1',
      slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
      slack,
    } as never;

    for (const cardTs of ['card-1', 'card-2']) {
      await handleReactionAddedEvent({
        context,
        event: {
          type: 'reaction_added',
          user: 'U1',
          reaction: 'thumbsup',
          item: { type: 'message', channel: 'C1', ts: cardTs },
          event_ts: `event-${cardTs}`,
        },
      });
    }

    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    expect(slack.addReaction).toHaveBeenCalledTimes(2);
    expect(
      mocks.startFastAgentResponse.mock.calls.map(
        ([input]) => input.event.thread_ts,
      ),
    ).toEqual(['execution-thread-1', 'execution-thread-2']);
    expect(mocks.getSessionForTask).not.toHaveBeenCalled();
    expect(mocks.conversationGetOrCreate).not.toHaveBeenCalled();
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

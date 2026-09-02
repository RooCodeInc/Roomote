// Unit coverage for the Telegram suggestion-button launch lifecycle in
// handleTelegramCallbackQuery: the claim's launchClaimedAt fencing token must
// be threaded through finalizeWorkItemLaunched on success and
// releaseWorkItemClaim on every no-launch/failure path, so a suggestion that
// launched a task can never be relaunched after the stale-claim window and a
// failed launch is retryable immediately instead of dead for 10 minutes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelegramCallbackQuery } from '@roomote/communication/telegram-update';

const {
  answerCallbackMock,
  apiLoggerMock,
  cancelOrphanedWorkItemRunBestEffortMock,
  claimTelegramSuggestionLaunchMock,
  findCurrentThreadSuggestionIdByMessageMock,
  claimCurrentThreadSuggestionByMessageMock,
  finalizeWorkItemLaunchedMock,
  postTelegramMessageBestEffortMock,
  releaseWorkItemClaimMock,
  resolveTelegramSenderUserIdMock,
  resolveTelegramWorkspaceMock,
  startNewTelegramTaskMock,
  continueFastAgentSurfaceReplyMock,
  getOrCreateFastAgentSessionMock,
} = vi.hoisted(() => ({
  answerCallbackMock: vi.fn(),
  apiLoggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  cancelOrphanedWorkItemRunBestEffortMock: vi.fn(),
  claimTelegramSuggestionLaunchMock: vi.fn(),
  findCurrentThreadSuggestionIdByMessageMock: vi.fn(),
  claimCurrentThreadSuggestionByMessageMock: vi.fn(),
  finalizeWorkItemLaunchedMock: vi.fn(),
  postTelegramMessageBestEffortMock: vi.fn(),
  releaseWorkItemClaimMock: vi.fn(),
  resolveTelegramSenderUserIdMock: vi.fn(),
  resolveTelegramWorkspaceMock: vi.fn(),
  startNewTelegramTaskMock: vi.fn(),
  continueFastAgentSurfaceReplyMock: vi.fn(),
  getOrCreateFastAgentSessionMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  continueFastAgentSurfaceReply: continueFastAgentSurfaceReplyMock,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getOrCreateFastAgentSession: getOrCreateFastAgentSessionMock,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown) => ({
    inArray: [column, values],
  })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  taskRuns: {
    id: 'taskRuns.id',
    payload: 'taskRuns.payload',
    status: 'taskRuns.status',
    canceledAt: 'taskRuns.canceledAt',
  },
  db: { query: { taskRuns: { findFirst: vi.fn() } } },
  finalizeWorkItemLaunched: finalizeWorkItemLaunchedMock,
  releaseWorkItemClaim: releaseWorkItemClaimMock,
}));

vi.mock('../../../logging.js', () => ({ apiLogger: apiLoggerMock }));

vi.mock('../../tasks/task-stop.js', () => ({ stopTaskRun: vi.fn() }));

vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: cancelOrphanedWorkItemRunBestEffortMock,
}));

vi.mock('../../tasks/current-thread-suggestion-reaction.js', () => ({
  findCurrentThreadSuggestionIdByMessage:
    findCurrentThreadSuggestionIdByMessageMock,
  claimCurrentThreadSuggestionByMessage:
    claimCurrentThreadSuggestionByMessageMock,
}));

vi.mock('../linked-user.js', () => ({
  resolveTelegramSenderUserId: resolveTelegramSenderUserIdMock,
}));

vi.mock('../replies.js', () => ({
  answerTelegramCallbackQueryBestEffort: answerCallbackMock,
  clearTelegramMessageButtonsBestEffort: vi.fn(),
  postTelegramMessageBestEffort: postTelegramMessageBestEffortMock,
}));

vi.mock('../routing-confirmation.js', () => ({
  handleTelegramRoutingCallback: vi.fn(),
}));

vi.mock('../setup-suggestions.js', () => ({
  claimTelegramSuggestionLaunch: claimTelegramSuggestionLaunchMock,
  parseTelegramSuggestionCallbackData: (data: string) =>
    data.startsWith('idea:') ? data.slice('idea:'.length) : null,
}));

vi.mock('../task-orchestration.js', () => ({
  startNewTelegramTask: startNewTelegramTaskMock,
}));

vi.mock('../task-launch.js', () => ({
  resolveTelegramWorkspace: resolveTelegramWorkspaceMock,
}));

import {
  handleTelegramCallbackQuery,
  handleTelegramSuggestionReaction,
} from '../callback-actions.js';

const WORK_ITEM_ID = 'work-item-1';
const CLAIMED_AT = new Date('2026-07-01T12:00:00.000Z');

function buildSuggestionQuery(threadId?: number): TelegramCallbackQuery {
  return {
    id: 'callback-1',
    from: { id: 42, is_bot: false, first_name: 'Matt' },
    data: `idea:${WORK_ITEM_ID}`,
    message: {
      message_id: 100,
      ...(threadId ? { message_thread_id: threadId } : {}),
      date: 0,
      chat: { id: 555, type: 'private' },
    },
  } as TelegramCallbackQuery;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveTelegramSenderUserIdMock.mockResolvedValue('user-1');
  claimTelegramSuggestionLaunchMock.mockResolvedValue({
    id: WORK_ITEM_ID,
    title: 'Fix the flaky test',
    brief: 'The retry loop never terminates.',
    investigationContext: null,
    targetRepositoryFullName: null,
    usesRouterLaunch: true,
    launchClaimedAt: CLAIMED_AT,
  });
  findCurrentThreadSuggestionIdByMessageMock.mockResolvedValue(WORK_ITEM_ID);
  claimCurrentThreadSuggestionByMessageMock.mockResolvedValue({
    outcome: 'claimed',
    suggestion: {
      id: WORK_ITEM_ID,
      title: 'Fix the flaky test',
      brief: 'The retry loop never terminates.',
      investigationContext: null,
      targetRepositoryFullName: null,
      usesRouterLaunch: true,
      launchClaimedAt: CLAIMED_AT,
    },
  });
  finalizeWorkItemLaunchedMock.mockResolvedValue(true);
  releaseWorkItemClaimMock.mockResolvedValue(true);
  cancelOrphanedWorkItemRunBestEffortMock.mockResolvedValue(
    'orphaned run canceled',
  );
  resolveTelegramWorkspaceMock.mockResolvedValue({
    environmentId: 'env-1',
    repoForPayload: 'acme/app',
    workspaceDisplayName: 'App',
  });
  getOrCreateFastAgentSessionMock.mockResolvedValue({ id: 'session-1' });
  continueFastAgentSurfaceReplyMock.mockResolvedValue(true);
});

describe('handleTelegramCallbackQuery suggestion launch lifecycle', () => {
  it('does not claim a reaction suggestion when account mapping fails', async () => {
    resolveTelegramSenderUserIdMock.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      handleTelegramSuggestionReaction({
        chat: { id: 555, type: 'private' },
        message_id: 100,
        date: 0,
        user: { id: 42, first_name: 'Matt' },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      }),
    ).rejects.toThrow('database unavailable');
    expect(claimCurrentThreadSuggestionByMessageMock).not.toHaveBeenCalled();
  });

  it('launches a reaction against the exact tracked suggestion message with linked-user attribution', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    const handled = await handleTelegramSuggestionReaction({
      chat: { id: 555, type: 'private' },
      message_id: 100,
      date: 0,
      user: { id: 42, first_name: 'Matt' },
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    });

    expect(handled).toBe(true);
    expect(claimCurrentThreadSuggestionByMessageMock).toHaveBeenCalledWith({
      surface: 'telegram',
      channelId: '555',
      messageId: '100',
    });
    expect(startNewTelegramTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchOwnerUserId: 'user-1',
        queuedMessage: expect.objectContaining({
          text: 'Fix the flaky test\n\nThe retry loop never terminates.',
          user: 'Matt',
          userId: 'user-1',
        }),
      }),
    );
    expect(answerCallbackMock).not.toHaveBeenCalled();
  });

  it('starts a suggestion in a fresh topic while preserving its source topic for fallback', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery(44));

    expect(startNewTelegramTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        forceNewTopic: true,
        queuedMessage: expect.objectContaining({ threadTs: '44' }),
        metadata: expect.objectContaining({ communicationThreadId: '44' }),
      }),
    );
  });

  it('keeps router-backed suggestions on the coding path when Fast is unavailable', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(startNewTelegramTaskMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ workspaceOverride: expect.anything() }),
    );
    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: WORK_ITEM_ID, taskId: 'task-1', claimedAt: CLAIMED_AT },
    );
  });

  it('launches directly in the environment saved on the suggestion', async () => {
    claimTelegramSuggestionLaunchMock.mockResolvedValue({
      id: WORK_ITEM_ID,
      title: 'Fix the flaky test',
      brief: 'The retry loop never terminates.',
      investigationContext: null,
      targetRepositoryFullName: 'acme/app',
      targetEnvironmentId: 'env-1',
      launchClaimedAt: CLAIMED_AT,
    });
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(resolveTelegramWorkspaceMock).toHaveBeenCalledWith({
      type: 'environment',
      id: 'env-1',
      name: 'env-1',
    });
    expect(startNewTelegramTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOverride: expect.objectContaining({ environmentId: 'env-1' }),
      }),
    );
  });

  it('launches an all-repositories suggestion without resolving an environment', async () => {
    claimTelegramSuggestionLaunchMock.mockResolvedValue({
      id: WORK_ITEM_ID,
      title: 'Fix the flaky test',
      brief: 'The retry loop never terminates.',
      investigationContext: null,
      targetRepositoryFullName: '__all_repositories__',
      launchTarget: '__all_repositories__',
      launchClaimedAt: CLAIMED_AT,
    });
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(resolveTelegramWorkspaceMock).not.toHaveBeenCalled();
    expect(startNewTelegramTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOverride: expect.objectContaining({
          repoForPayload: '__all_repositories__',
        }),
      }),
    );
  });

  it('starts a Fast-targeted suggestion without launching a coding task', async () => {
    claimTelegramSuggestionLaunchMock.mockResolvedValue({
      id: WORK_ITEM_ID,
      title: 'Fix the flaky test',
      brief: 'The retry loop never terminates.',
      investigationContext: null,
      targetRepositoryFullName: '__fast__',
      launchTarget: '__fast__',
      launchClaimedAt: CLAIMED_AT,
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(getOrCreateFastAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(continueFastAgentSurfaceReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        question: expect.stringContaining('Fix the flaky test'),
      }),
    );
    expect(startNewTelegramTaskMock).not.toHaveBeenCalled();
    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: WORK_ITEM_ID, taskId: null, claimedAt: CLAIMED_AT },
    );
  });

  it('finalizes the work item with the task id and the claim token on success', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledTimes(1);
    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: WORK_ITEM_ID, taskId: 'task-1', claimedAt: CLAIMED_AT },
    );
    expect(releaseWorkItemClaimMock).not.toHaveBeenCalled();
  });

  it('best-effort cancels the orphaned run and logs loudly when finalize loses the fencing guard', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });
    finalizeWorkItemLaunchedMock.mockResolvedValue(false);

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(cancelOrphanedWorkItemRunBestEffortMock).toHaveBeenCalledWith(7);
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(WORK_ITEM_ID),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('task-1'),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned run canceled'),
    );
    // The earlier "Starting: ..." answer and started post point at the
    // canceled orphan, so the user gets a corrective reply.
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('was already started elsewhere'),
      }),
    );
    expect(releaseWorkItemClaimMock).not.toHaveBeenCalled();
  });

  it('still logs the loud warn when the orphaned-run cancel reports a failure', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });
    finalizeWorkItemLaunchedMock.mockResolvedValue(false);
    // The helper never throws; a failed cancel comes back as a note.
    cancelOrphanedWorkItemRunBestEffortMock.mockResolvedValue(
      'orphaned run cancel failed: db unavailable',
    );

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(WORK_ITEM_ID),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned run cancel failed: db unavailable'),
    );
  });

  it('does not cancel or post a corrective reply when finalize succeeds', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(cancelOrphanedWorkItemRunBestEffortMock).not.toHaveBeenCalled();
    expect(postTelegramMessageBestEffortMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('was already started elsewhere'),
      }),
    );
  });

  it('releases the claim with the token when routing replies inline (no task launched)', async () => {
    startNewTelegramTaskMock.mockResolvedValue({
      status: 'replied_inline',
      routingDecision: { status: 'platform_answer' },
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(finalizeWorkItemLaunchedMock).not.toHaveBeenCalled();
    expect(releaseWorkItemClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemClaimMock).toHaveBeenCalledWith(expect.anything(), {
      id: WORK_ITEM_ID,
      claimedAt: CLAIMED_AT,
    });
  });

  it('releases the claim with the token when the launch throws, so the suggestion is retryable immediately', async () => {
    startNewTelegramTaskMock.mockRejectedValue(new Error('enqueue exploded'));

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(finalizeWorkItemLaunchedMock).not.toHaveBeenCalled();
    expect(releaseWorkItemClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemClaimMock).toHaveBeenCalledWith(expect.anything(), {
      id: WORK_ITEM_ID,
      claimedAt: CLAIMED_AT,
    });
    // The user still gets the visible failure reply.
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Could not start'),
      }),
    );
  });

  it('posts the canonical read-only message when the suggestion launch is policy-blocked', async () => {
    startNewTelegramTaskMock.mockRejectedValue({
      code: 'deployment_read_only',
    });

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(releaseWorkItemClaimMock).toHaveBeenCalledWith(expect.anything(), {
      id: WORK_ITEM_ID,
      claimedAt: CLAIMED_AT,
    });
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'New tasks are paused due to a billing issue. Please check billing.',
      }),
    );
  });

  it('does not launch or touch the claim helpers when the claim CAS loses', async () => {
    claimTelegramSuggestionLaunchMock.mockResolvedValue(null);

    await handleTelegramCallbackQuery(buildSuggestionQuery());

    expect(startNewTelegramTaskMock).not.toHaveBeenCalled();
    expect(finalizeWorkItemLaunchedMock).not.toHaveBeenCalled();
    expect(releaseWorkItemClaimMock).not.toHaveBeenCalled();
  });
});

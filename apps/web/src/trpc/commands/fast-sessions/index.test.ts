const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  findAccessibleSession: vi.fn(),
  getOfferStatus: vi.fn(),
  handleReviewAction: vi.fn(),
  retireReviewActions: vi.fn(),
  updateOfferStatus: vi.fn(),
  buildReplyDelivery: vi.fn(),
  createWebTaskLauncher: vi.fn(),
  launchTask: vi.fn(),
  notifyArtifactBuild: vi.fn(),
  getOrCreateSession: vi.fn(),
  getUnifiedSession: vi.fn(),
  isNull: vi.fn(),
  getFastSessionTasks: vi.fn(),
  getArtifactBuildParentSession: vi.fn(),
  currentEpochSeconds: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  dbSelect: vi.fn(),
  dbInnerJoin: vi.fn(),
  dbSelectLimit: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  createFastAgentWebTaskLauncher: mocks.createWebTaskLauncher,
  getOrCreateFastAgentSession: mocks.getOrCreateSession,
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentSurfaceReplyDelivery: mocks.buildReplyDelivery,
  resolveUserMcpServerConfigs: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { update: mocks.dbUpdate, select: mocks.dbSelect },
  retireCanonicalPrReviewActionsForDestinationKey: mocks.retireReviewActions,
  and: vi.fn(),
  eq: vi.fn(),
  isNull: mocks.isNull,
  sql: vi.fn(),
  fastAgentConversations: {},
  fastAgentMessages: {},
  sessions: {},
  sessionTasks: {},
  taskRuns: {},
  getSessionForFastConversation: mocks.getUnifiedSession,
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findAccessibleSession,
  buildFastSessionPrReviewDestinationKey: () => '["web","user-1","session-1"]',
  getFastSessionPrReviewOfferStatus: mocks.getOfferStatus,
  getFastSessionTasks: mocks.getFastSessionTasks,
  updateFastSessionPrReviewOfferStatus: mocks.updateOfferStatus,
}));

vi.mock('@/lib/server/sessions', () => ({
  getArtifactBuildParentSession: mocks.getArtifactBuildParentSession,
}));

vi.mock('@/lib/server/artifact-signature', () => ({
  currentEpochSeconds: mocks.currentEpochSeconds,
  signArtifactId: (artifactId: string, timestamp: number) =>
    `signature-${artifactId}-${timestamp}`,
}));

vi.mock('@/lib/server/pr-review-actions', () => ({
  handleWebPrReviewAction: mocks.handleReviewAction,
}));

vi.mock('../task-runs', () => ({
  notifySourceTaskArtifactBuild: mocks.notifyArtifactBuild,
}));

import {
  getFastSessionTasksCommand,
  handleFastSessionPrReviewActionCommand,
  replyToFastSessionCommand,
  scheduleWebFastAgentTurn,
  startFastSessionCommand,
  startSetupFastSessionCommand,
  updateFastSessionModelSelectionCommand,
} from './index';

describe('getFastSessionTasksCommand', () => {
  it('adds stable image and video preview URLs to Fast-session artifacts', async () => {
    mocks.currentEpochSeconds.mockReturnValue(7_201);
    mocks.getFastSessionTasks.mockResolvedValue([
      {
        taskId: 'task-1',
        title: 'Fast task',
        inferenceCostMicroUsd: 0,
        artifacts: [
          {
            id: 'artifact-image',
            path: 'screenshots/result.png',
            version: 1,
            artifactType: 'visual-proof',
            contentType: 'image/png',
            size: 100,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            id: 'artifact-video',
            path: 'recordings/result.webm',
            version: 1,
            artifactType: 'visual-proof',
            contentType: 'video/webm',
            size: 200,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      },
    ]);

    const result = await getFastSessionTasksCommand(auth, 'session-1');

    expect(result?.[0]?.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-image',
        thumbnailUrl:
          '/api/artifacts/artifact-image/raw?sig=signature-artifact-image-7200&ts=7200',
      }),
      expect.objectContaining({
        id: 'artifact-video',
        previewUrl:
          '/api/artifacts/artifact-video/raw?sig=signature-artifact-video-7200&ts=7200',
      }),
    ]);
  });
});

const auth = {
  userId: 'user-1',
  isAdmin: false,
  name: 'User One',
  primaryEmail: 'user@example.com',
} as never;

const session = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: 'user-1',
  surface: 'web',
  workspaceId: 'user-1',
  conversationId: 'session-1',
  model: null,
  reasoningEffort: null,
};

describe('scheduleWebFastAgentTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbSet });
    mocks.dbSet.mockReturnValue({ where: mocks.dbWhere });
    mocks.dbWhere.mockResolvedValue(undefined);
  });

  it('keeps the complete Fast turn in the request post-response lifecycle', async () => {
    let scheduled: (() => Promise<void>) | undefined;
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockResolvedValue('Recovered response');

    scheduleWebFastAgentTurn({
      userId: 'user-1',
      delivery: {
        conversation: {
          surface: 'web',
          workspaceId: 'user-1',
          conversationId: 'session-1',
        },
        adapter: { launchTask: vi.fn(), postReply: vi.fn() },
      },
      question: 'Try again',
    });

    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.acquireTurnLock).not.toHaveBeenCalled();

    await scheduled?.();

    expect(mocks.answerQuestion).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('persists an explicit model selection before the next turn', async () => {
    mocks.findAccessibleSession.mockResolvedValue({
      id: 'fast-session-1',
      model: null,
      reasoningEffort: null,
    });

    await expect(
      updateFastSessionModelSelectionCommand(auth, {
        sessionId: '00000000-0000-4000-8000-000000000000',
        model: 'openrouter/z-ai/glm-5.2',
        reasoningEffort: 'high',
      }),
    ).resolves.toEqual({ success: true });

    expect(mocks.dbSet).toHaveBeenCalledWith({
      model: 'openrouter/z-ai/glm-5.2',
      reasoningEffort: 'high',
    });
  });
});

describe('startFastSessionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWebTaskLauncher.mockReturnValue(mocks.launchTask);
    mocks.launchTask.mockResolvedValue({ success: true, taskId: 'task-1' });
    mocks.getUnifiedSession.mockResolvedValue({ id: 'unified-session-1' });
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'fast-session-1',
      created: true,
    });
    mocks.getArtifactBuildParentSession.mockResolvedValue({
      sourceTaskId: 'source-task-1',
      sourceArtifactPath: 'plans/widget.md',
      sourceArtifactVersion: 3,
      sessionId: 'unified-session-1',
      fastConversationId: 'fast-session-1',
    });
    mocks.buildReplyDelivery.mockResolvedValue({
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'existing-conversation',
      },
      adapter: { launchTask: mocks.launchTask, postReply: vi.fn() },
    });
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ limit: mocks.dbSelectLimit }),
        innerJoin: mocks.dbInnerJoin,
      }),
    });
    mocks.dbInnerJoin.mockReturnValue({
      where: () => ({ limit: mocks.dbSelectLimit }),
    });
    mocks.dbSelectLimit.mockResolvedValue([]);
  });

  it('recovers an idempotent Session without scheduling its first turn twice', async () => {
    const input = {
      text: 'Review the starter prompt',
      conversationId: 'setup-starter:batch-1:speed-up-ci',
    };

    await expect(startFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      fastConversationId: 'fast-session-1',
    });
    mocks.getOrCreateSession.mockResolvedValueOnce({
      id: 'fast-session-1',
      created: false,
    });
    mocks.dbSelectLimit.mockResolvedValueOnce([{ id: 'message-1' }]);
    await expect(startFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      fastConversationId: 'fast-session-1',
    });

    expect(mocks.getOrCreateSession).toHaveBeenCalledTimes(2);
    expect(mocks.getOrCreateSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: input.conversationId,
      },
    });
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it('recovers a deterministic Session kickoff lost after creation', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'fast-session-1',
      created: false,
    });
    mocks.dbSelectLimit.mockResolvedValue([]);

    await startFastSessionCommand(auth, {
      text: 'Build the plan',
      conversationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it('launches an attributed artifact build in the artifact task parent Session', async () => {
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);

    await startFastSessionCommand(auth, {
      text: 'Build the plan',
      artifactBuild: {
        launchId: '11111111-1111-4111-8111-111111111111',
        environmentId: '33333333-3333-4333-8333-333333333333',
        branch: 'feature/source-branch',
        taskModel: 'model-1',
        sourceArtifactId: '22222222-2222-4222-8222-222222222222',
        sourceArtifactPath: 'plans/widget.md',
        sourceArtifactVersion: 3,
      },
    });
    expect(mocks.getArtifactBuildParentSession).toHaveBeenCalledWith(
      auth,
      '22222222-2222-4222-8222-222222222222',
    );
    expect(mocks.getOrCreateSession).not.toHaveBeenCalled();
    expect(mocks.buildReplyDelivery).toHaveBeenCalledWith({
      sessionId: 'fast-session-1',
      userId: 'user-1',
      senderDisplayName: 'User One',
      question: 'Build the plan',
    });
    expect(mocks.createWebTaskLauncher).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'existing-conversation',
      },
    });
    await scheduled?.();

    const turnInput = mocks.answerQuestion.mock.calls[0]?.[0];
    await turnInput.adapter.launchTask({
      prompt: 'Build the plan',
      environmentId: 'different-environment',
      model: 'different-model',
      parentSessionId: 'different-session',
      postKickoff: vi.fn(),
    });

    expect(mocks.launchTask).toHaveBeenCalledWith({
      prompt: 'Build the plan',
      environmentId: '33333333-3333-4333-8333-333333333333',
      branch: 'feature/source-branch',
      launchIdempotencyKey:
        'artifact-build:11111111-1111-4111-8111-111111111111',
      model: 'model-1',
      parentSessionId: 'fast-session-1',
      postKickoff: expect.any(Function),
    });

    expect(mocks.notifyArtifactBuild).toHaveBeenCalledWith({
      auth,
      sourceTaskId: 'source-task-1',
      sourceArtifactId: '22222222-2222-4222-8222-222222222222',
      sourceArtifactPath: 'plans/widget.md',
      sourceArtifactVersion: 3,
      newTaskId: 'task-1',
    });
  });

  it('recovers an artifact kickoff without a non-canceled matching task', async () => {
    mocks.dbSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'message-1' }])
      .mockResolvedValueOnce([]);

    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    await startFastSessionCommand(auth, {
      text: 'Build the plan',
      artifactBuild: {
        launchId: '11111111-1111-4111-8111-111111111111',
        environmentId: '33333333-3333-4333-8333-333333333333',
        taskModel: 'model-1',
        sourceArtifactId: '22222222-2222-4222-8222-222222222222',
        sourceArtifactPath: 'plans/widget.md',
        sourceArtifactVersion: 3,
      },
    });
    await scheduled?.();

    expect(mocks.answerQuestion).toHaveBeenCalledOnce();
    expect(mocks.isNull).toHaveBeenCalled();
  });

  it('rejects an artifact build when its owning task has no Session', async () => {
    mocks.getArtifactBuildParentSession.mockResolvedValue({
      sourceTaskId: 'source-task-1',
      sourceArtifactPath: 'plans/widget.md',
      sourceArtifactVersion: 3,
      sessionId: null,
      fastConversationId: null,
    });

    await expect(
      startFastSessionCommand(auth, {
        text: 'Build the plan',
        artifactBuild: {
          launchId: '11111111-1111-4111-8111-111111111111',
          environmentId: '33333333-3333-4333-8333-333333333333',
          taskModel: 'model-1',
          sourceArtifactId: '22222222-2222-4222-8222-222222222222',
          sourceArtifactPath: 'plans/widget.md',
          sourceArtifactVersion: 3,
        },
      }),
    ).rejects.toThrow(
      'The task that created this artifact is not attached to a Session.',
    );

    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('rejects an artifact build when its Session has no Fast parent', async () => {
    mocks.getArtifactBuildParentSession.mockResolvedValue({
      sourceTaskId: 'source-task-1',
      sourceArtifactPath: 'plans/widget.md',
      sourceArtifactVersion: 3,
      sessionId: 'unified-session-1',
      fastConversationId: null,
    });

    await expect(
      startFastSessionCommand(auth, {
        text: 'Build the plan',
        artifactBuild: {
          launchId: '11111111-1111-4111-8111-111111111111',
          environmentId: '33333333-3333-4333-8333-333333333333',
          taskModel: 'model-1',
          sourceArtifactId: '22222222-2222-4222-8222-222222222222',
          sourceArtifactPath: 'plans/widget.md',
          sourceArtifactVersion: 3,
        },
      }),
    ).rejects.toThrow("This artifact's Session cannot start a delegated task.");

    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('does not retry an artifact kickoff after its task is attached', async () => {
    mocks.dbSelectLimit.mockResolvedValueOnce([{ taskId: 'task-1' }]);

    await startFastSessionCommand(auth, {
      text: 'Build the plan',
      artifactBuild: {
        launchId: '11111111-1111-4111-8111-111111111111',
        environmentId: '33333333-3333-4333-8333-333333333333',
        taskModel: 'model-1',
        sourceArtifactId: '22222222-2222-4222-8222-222222222222',
        sourceArtifactPath: 'plans/widget.md',
        sourceArtifactVersion: 3,
      },
    });

    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe('startSetupFastSessionCommand', () => {
  const input = {
    conversationId: 'setup-session:batch-1',
    title: 'Set up Roomote',
    event: { type: 'setup_session_started' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWebTaskLauncher.mockReturnValue(vi.fn());
    mocks.getUnifiedSession.mockResolvedValue({ id: 'unified-session-1' });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbSet });
    mocks.dbSet.mockReturnValue({ where: mocks.dbWhere });
    mocks.dbWhere.mockResolvedValue(undefined);
    mocks.dbSelect.mockReturnValue({
      from: () => ({ where: () => ({ limit: mocks.dbSelectLimit }) }),
    });
    mocks.dbSelectLimit.mockResolvedValue([]);
  });

  it('schedules the kickoff and titles the session on creation', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: true,
    });

    await expect(startSetupFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      created: true,
    });

    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.dbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up Roomote',
        titleEditedByUserAt: expect.any(Date),
      }),
    );
    // No transcript probe is needed when the conversation was just created.
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it('skips a scheduled kickoff whose transcript gained messages before the turn lock', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: true,
    });
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);

    await startSetupFastSessionCommand(auth, input);
    expect(scheduled).toBeDefined();

    // A concurrent submit's kickoff persisted its prompt row first: the
    // re-check under the turn lock sees the kickoff event and skips.
    mocks.dbSelectLimit.mockResolvedValue([{ id: 'message-1' }]);
    await scheduled?.();

    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs a scheduled kickoff whose transcript is still empty at the turn lock', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: true,
    });
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockResolvedValue('Welcome');

    await startSetupFastSessionCommand(auth, input);
    await scheduled?.();

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        turnSource: 'platform_event',
        platformEventKind: 'setup',
        platformEventVisibility: 'required',
        currentMessageId: 'setup-kickoff:setup-conversation-1',
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('recovers a lost kickoff when reusing a conversation with an empty transcript', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: false,
    });
    mocks.dbSelectLimit.mockResolvedValue([]);

    await expect(startSetupFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      created: false,
    });

    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it('does not schedule a second kickoff once the kickoff event row exists', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: false,
    });
    mocks.dbSelectLimit.mockResolvedValue([{ id: 'message-1' }]);

    await expect(startSetupFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      created: false,
    });

    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });

  it('still schedules the kickoff when the title updates fail', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: true,
    });
    mocks.dbWhere.mockRejectedValue(new Error('title write failed'));

    await expect(startSetupFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      created: true,
    });

    expect(mocks.after).toHaveBeenCalledOnce();
  });
});

describe('Fast session PR review actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAccessibleSession.mockResolvedValue(session);
    mocks.updateOfferStatus.mockResolvedValue(undefined);
  });

  it('delegates an authorized offer to the shared web action lifecycle', async () => {
    mocks.handleReviewAction.mockResolvedValue({ status: 'resolved' });

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).resolves.toEqual({ status: 'resolved' });
    expect(mocks.handleReviewAction).toHaveBeenCalledWith({
      deliveryId: '11111111-1111-4111-8111-111111111111',
      choice: 'yes',
      actingUserId: 'user-1',
      expectedDestinationKind: 'fast_conversation',
      expectedDestinationKey: '["web","user-1","session-1"]',
      getOfferStatus: expect.any(Function),
      updateOfferStatus: expect.any(Function),
    });
    const [{ getOfferStatus, updateOfferStatus }] =
      mocks.handleReviewAction.mock.calls[0]!;
    mocks.getOfferStatus.mockResolvedValue('resolved');
    await expect(getOfferStatus()).resolves.toBe('resolved');
    expect(mocks.getOfferStatus).toHaveBeenCalledWith(
      session.id,
      '11111111-1111-4111-8111-111111111111',
    );
    await updateOfferStatus('resolved');
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'resolved',
    );
  });

  it('rejects inaccessible sessions before entering the shared lifecycle', async () => {
    mocks.findAccessibleSession.mockResolvedValue(null);

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).rejects.toThrow('Fast session not found');
    expect(mocks.handleReviewAction).not.toHaveBeenCalled();
    expect(mocks.updateOfferStatus).not.toHaveBeenCalled();
  });

  it('retires open offers when the user types a reply', async () => {
    mocks.retireReviewActions.mockResolvedValue([
      '11111111-1111-4111-8111-111111111111',
    ]);
    mocks.buildReplyDelivery.mockResolvedValue({
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'session-1',
      },
      adapter: { launchTask: vi.fn(), postReply: vi.fn() },
    });

    await replyToFastSessionCommand(auth, {
      sessionId: session.id,
      text: 'I will handle this another way.',
    });

    expect(mocks.retireReviewActions).toHaveBeenCalledWith({
      destinationKind: 'fast_conversation',
      destinationKey: '["web","user-1","session-1"]',
    });
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'dismissed',
    );
  });
});

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
  startPinnedLaunch: vi.fn(),
  getOrCreateSession: vi.fn(),
  getUnifiedSession: vi.fn(),
  getFastSessionTasks: vi.fn(),
  currentEpochSeconds: vi.fn(),
  createSessionArtifact: vi.fn(),
  createConversationArtifact: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  dbSelect: vi.fn(),
  dbInnerJoin: vi.fn(),
  dbSelectLimit: vi.fn(),
  resolveSetupContext: vi.fn().mockResolvedValue(null),
  submitSetupInput: vi.fn(),
  upsertMessage: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  buildFastAgentSetupAdapter: vi.fn(() => ({})),
  createFastAgentWebTaskLauncher: mocks.createWebTaskLauncher,
  FastAgentDurableRetryScheduledError: class FastAgentDurableRetryScheduledError extends Error {},
  getOrCreateFastAgentSession: mocks.getOrCreateSession,
  resolveApiBaseUrl: vi.fn(),
  upsertFastAgentMessage: mocks.upsertMessage,
}));

vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentArtifactCreator: vi.fn(() => mocks.createConversationArtifact),
  buildFastAgentSurfaceReplyDelivery: mocks.buildReplyDelivery,
  createFastAgentSessionArtifact: mocks.createSessionArtifact,
  persistFastAgentInlineHumanTurn: vi.fn().mockResolvedValue(null),
  resolveUserMcpServerConfigs: vi.fn(),
  wakeFastAgentParentEventAt: vi.fn(),
  wakeFastAgentParentEventNow: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { update: mocks.dbUpdate, select: mocks.dbSelect },
  retireCanonicalPrReviewActionsForDestinationKey: mocks.retireReviewActions,
  and: vi.fn(),
  eq: vi.fn(),
  sql: vi.fn(),
  fastAgentConversations: {},
  fastAgentMessages: {},
  sessions: {},
  getSessionForFastConversation: mocks.getUnifiedSession,
  ensureSessionForFastConversation: mocks.getUnifiedSession,
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findAccessibleSession,
  buildFastSessionPrReviewDestinationKey: () => '["web","user-1","session-1"]',
  getFastSessionPrReviewOfferStatus: mocks.getOfferStatus,
  getFastSessionTasks: mocks.getFastSessionTasks,
  updateFastSessionPrReviewOfferStatus: mocks.updateOfferStatus,
}));

vi.mock('@/lib/server/artifact-signature', () => ({
  currentEpochSeconds: mocks.currentEpochSeconds,
  signArtifactId: (artifactId: string, timestamp: number) =>
    `signature-${artifactId}-${timestamp}`,
}));

vi.mock('@/lib/server/pr-review-actions', () => ({
  handleWebPrReviewAction: mocks.handleReviewAction,
}));

vi.mock('./pinned-launch', () => ({
  startPinnedFastSessionLaunch: mocks.startPinnedLaunch,
}));

vi.mock('../setup/setup-session', () => ({
  resolveSetupSessionTurnContext: mocks.resolveSetupContext,
  submitSetupSessionUserInputCommand: mocks.submitSetupInput,
}));

import {
  getFastSessionTasksCommand,
  handleFastSessionPrReviewActionCommand,
  replyToFastSessionCommand,
  scheduleWebFastAgentTurn,
  startFastSessionCommand,
  startSetupFastSessionCommand,
  updateFastSessionModelSelectionCommand,
  submitFastSessionUserInputCommand,
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

describe('setup context on ordinary Fast session input', () => {
  afterEach(() => {
    mocks.resolveSetupContext.mockReset().mockResolvedValue(null);
  });
  const resolvePreset = vi.fn();
  const initialSnapshot = JSON.stringify({
    integrationDiscovery: { completed: false, answeredCategoryIds: [] },
  });
  const freshSnapshot = JSON.stringify({
    integrationDiscovery: {
      completed: false,
      answeredCategoryIds: ['documents'],
      matchedIntegrationIds: ['granola'],
    },
  });
  const setupContext = {
    setupSession: true,
    adapterExtensions: { resolveUserInputPreset: resolvePreset },
    setupSnapshot: initialSnapshot,
    setupContext: {
      sessionId: 'session-1',
      fastConversationId: 'session-1',
      setupSnapshot: initialSnapshot,
      starterTaskOptions: [],
    },
  };
  const question = {
    id: 'setup-tools-documents',
    header: 'Documents',
    question: 'Where do you keep documents?',
    isOther: true,
    isSecret: false,
  };
  const request = {
    eventId: 'request-event',
    turnId: 'request-turn',
    payload: {
      requestId: 'request-1',
      sessionId: 'session-1',
      turnId: 'request-turn',
      callId: 'request-call',
      status: 'pending',
      questions: [question],
    },
  };
  const input = {
    sessionId: 'session-1',
    requestId: 'request-1',
    answers: { 'setup-tools-documents': { answers: ['Granola'] } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.after.mockReset();
    mocks.resolveSetupContext.mockReset().mockResolvedValue(null);
    mocks.upsertMessage.mockReset().mockResolvedValue(undefined);
    mocks.findAccessibleSession.mockResolvedValue(session);
    mocks.acquireTurnLock.mockResolvedValue(
      Object.assign(vi.fn().mockResolvedValue(undefined), {
        signal: new AbortController().signal,
      }),
    );
    mocks.answerQuestion.mockResolvedValue('Ready');
    mocks.buildReplyDelivery.mockResolvedValue({
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'session-1',
      },
      adapter: { launchTask: mocks.launchTask, postReply: vi.fn() },
    });
    mocks.retireReviewActions.mockResolvedValue([]);
    mocks.updateOfferStatus.mockResolvedValue(undefined);
    mocks.dbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: mocks.dbSelectLimit,
          orderBy: () => ({ limit: mocks.dbSelectLimit }),
        }),
      }),
    });
    mocks.dbSelectLimit.mockReset().mockResolvedValue([]);
    mocks.submitSetupInput.mockResolvedValue({ success: true });
  });

  async function runScheduled() {
    expect(mocks.after).toHaveBeenCalledOnce();
    await mocks.after.mock.calls[0]![0]();
    return mocks.answerQuestion.mock.calls[0]![0];
  }

  it('attaches setup adapters and snapshot to ordinary prose replies', async () => {
    mocks.resolveSetupContext.mockResolvedValue(setupContext);
    await replyToFastSessionCommand(auth, {
      sessionId: session.id,
      text: 'We use Granola. Skip the other questions.',
    });
    const turn = await runScheduled();
    expect(turn).toMatchObject({
      setupSession: true,
      setupSnapshot: initialSnapshot,
      adapter: { resolveUserInputPreset: resolvePreset },
    });
    expect(mocks.resolveSetupContext).toHaveBeenCalledWith(auth, session.id);
    const { persistFastAgentInlineHumanTurn } =
      await import('@roomote/sdk/server');
    expect(vi.mocked(persistFastAgentInlineHumanTurn)).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: session.id }),
      event: expect.objectContaining({
        setupSession: true,
        setupContext: setupContext.setupContext,
      }),
    });
  });

  it('leaves ordinary non-setup replies unchanged', async () => {
    await replyToFastSessionCommand(auth, {
      sessionId: session.id,
      text: 'Review this change.',
    });
    const turn = await runScheduled();
    expect(turn.setupSession).toBeUndefined();
    expect(turn.setupSnapshot).toBeUndefined();
    expect(turn.adapter.resolveUserInputPreset).toBeUndefined();
  });

  it('refreshes setup snapshots after category response persistence, overriding stale caller context', async () => {
    mocks.dbSelectLimit
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([]);
    mocks.resolveSetupContext
      .mockResolvedValueOnce(setupContext)
      .mockImplementation(async () => {
        expect(mocks.upsertMessage).toHaveBeenCalledOnce();
        return {
          ...setupContext,
          setupSnapshot: freshSnapshot,
          setupContext: {
            ...setupContext.setupContext,
            setupSnapshot: freshSnapshot,
          },
        };
      });
    await submitFastSessionUserInputCommand(auth, input, {
      setupSession: true,
      setupSnapshot: initialSnapshot,
    });
    const turn = await runScheduled();
    expect(turn).toMatchObject({
      setupSession: true,
      setupSnapshot: freshSnapshot,
      adapter: { resolveUserInputPreset: resolvePreset },
    });
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          payload: expect.objectContaining({
            answers: input.answers,
            resolution: 'submitted',
          }),
        }),
      }),
    );
    const { persistFastAgentInlineHumanTurn } =
      await import('@roomote/sdk/server');
    expect(vi.mocked(persistFastAgentInlineHumanTurn)).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: session.id }),
      event: expect.objectContaining({
        turnSource: 'platform_event',
        platformEventKind: 'input_response',
        setupSession: true,
        setupContext: expect.objectContaining({ setupSnapshot: freshSnapshot }),
      }),
    });
  });

  it.each(['documents', 'communication'])(
    'resumes cancelled %s discovery questions as an early skip without marking discovery complete',
    async (category) => {
      mocks.dbSelectLimit
        .mockResolvedValueOnce([
          {
            ...request,
            payload: {
              ...request.payload,
              questions: [{ ...question, id: `setup-tools-${category}` }],
            },
          },
        ])
        .mockResolvedValueOnce([]);
      const skippedSnapshot = JSON.stringify({
        integrationDiscovery: { completed: false, skipped: true },
      });
      mocks.resolveSetupContext
        .mockResolvedValueOnce(setupContext)
        .mockImplementation(async () => {
          expect(mocks.upsertMessage).toHaveBeenCalledOnce();
          return {
            ...setupContext,
            setupSnapshot: skippedSnapshot,
            setupContext: {
              ...setupContext.setupContext,
              setupSnapshot: skippedSnapshot,
            },
          };
        });
      await submitFastSessionUserInputCommand(auth, {
        ...input,
        answers: {},
        resolution: 'cancelled',
      });
      const turn = await runScheduled();
      expect(turn).toMatchObject({
        setupSession: true,
        setupSnapshot: skippedSnapshot,
      });
      expect(turn.question).toContain('"resolution":"cancelled"');
    },
  );

  it('keeps generic non-setup submissions and cancellation behavior unchanged', async () => {
    mocks.dbSelectLimit
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([]);
    await submitFastSessionUserInputCommand(auth, input);
    const turn = await runScheduled();
    expect(turn.setupSession).toBe(false);
    expect(turn.setupSnapshot).toBeUndefined();
    expect(turn.adapter.resolveUserInputPreset).toBeUndefined();
    expect(turn.question).toBe(
      `<structured_input_response>${JSON.stringify({ requestId: input.requestId, answers: input.answers })}</structured_input_response>`,
    );
    mocks.after.mockClear();
    mocks.dbSelectLimit
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([]);
    await submitFastSessionUserInputCommand(auth, {
      ...input,
      answers: {},
      resolution: 'cancelled',
    });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('treats a duplicate saved setup category response as successful without scheduling twice', async () => {
    const saved = {
      eventId: 'response-event',
      payload: {
        requestId: 'request-1',
        sessionId: 'session-1',
        turnId: 'request-turn',
        callId: 'request-call',
        answers: input.answers,
        resolution: 'submitted',
      },
    };
    mocks.dbSelectLimit
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([saved]);
    mocks.resolveSetupContext.mockResolvedValue({
      ...setupContext,
      setupSnapshot: freshSnapshot,
      setupContext: {
        ...setupContext.setupContext,
        setupSnapshot: freshSnapshot,
      },
    });
    await submitFastSessionUserInputCommand(auth, input);
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('does not schedule when another generic response-row claimant won', async () => {
    mocks.dbSelectLimit
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([]);
    mocks.upsertMessage.mockResolvedValueOnce({
      initialHumanTurn: false,
      inserted: false,
    });

    await expect(
      submitFastSessionUserInputCommand(auth, input),
    ).resolves.toEqual({ success: true });

    expect(mocks.upsertMessage).toHaveBeenCalledOnce();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('routes final presets through setup-specific persistence, not ordinary response writes', async () => {
    mocks.resolveSetupContext.mockResolvedValue(setupContext);
    const final = {
      ...request,
      payload: {
        ...request.payload,
        preset: 'setup_integrations',
        questions: [
          {
            ...question,
            id: 'setup-integrations',
            isOther: false,
            options: [
              {
                id: 'continue',
                label: 'Continue',
                description: 'Continue without connections',
              },
            ],
          },
        ],
      },
    };
    mocks.dbSelectLimit
      .mockResolvedValueOnce([final])
      .mockResolvedValueOnce([]);
    const finalInput = {
      ...input,
      answers: { 'setup-integrations': { answers: ['Continue'] } },
    };
    await submitFastSessionUserInputCommand(auth, finalInput);
    expect(mocks.submitSetupInput).toHaveBeenCalledWith(auth, finalInput);
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('checks setup admin ownership before an ordinary response is persisted', async () => {
    mocks.resolveSetupContext.mockRejectedValue(new Error('Unauthorized'));
    await expect(
      submitFastSessionUserInputCommand(auth, input),
    ).rejects.toThrow('Unauthorized');
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
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
    mocks.answerQuestion.mockResolvedValue('');
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
    mocks.answerQuestion.mockResolvedValue('');
    mocks.createWebTaskLauncher.mockReturnValue(mocks.launchTask);
    mocks.launchTask.mockResolvedValue({ success: true, taskId: 'task-1' });
    mocks.getUnifiedSession.mockResolvedValue({ id: 'unified-session-1' });
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'fast-session-1',
      created: true,
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

  it('lets the initial Fast Session turn create a Session-owned artifact', async () => {
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockImplementation(async ({ adapter }) =>
      adapter.createArtifact({
        path: 'notes/decision.md',
        content: '# Decision',
        contentType: 'text/markdown',
        artifactType: 'general',
      }),
    );

    await startFastSessionCommand(auth, { text: 'Create a decision record' });
    await scheduled?.();

    expect(mocks.createSessionArtifact).toHaveBeenCalledWith({
      sessionId: 'unified-session-1',
      path: 'notes/decision.md',
      content: '# Decision',
      contentType: 'text/markdown',
      artifactType: 'general',
    });
  });

  it('delegates a pinned launch without scheduling a Fast turn', async () => {
    mocks.startPinnedLaunch.mockResolvedValue({
      sessionId: 'session-9',
      fastConversationId: 'fast-9',
      taskId: 'task-9',
    });

    const pinnedLaunch = {
      launchId: '44444444-4444-4444-8444-444444444444',
      repo: 'acme/api',
      branch: 'main',
      environmentId: '33333333-3333-4333-8333-333333333333',
    };
    const result = await startFastSessionCommand(auth, {
      text: 'Fix the flaky test',
      images: ['data:image/png;base64,AAAA'],
      attachmentTexts: ['notes'],
      model: 'model-1',
      reasoningEffort: 'high',
      pinnedLaunch,
    });

    expect(result).toEqual({
      sessionId: 'session-9',
      fastConversationId: 'fast-9',
      taskId: 'task-9',
    });
    expect(mocks.startPinnedLaunch).toHaveBeenCalledWith(auth, {
      text: 'Fix the flaky test',
      images: ['data:image/png;base64,AAAA'],
      attachmentTexts: ['notes'],
      model: 'model-1',
      reasoningEffort: 'high',
      pinnedLaunch,
    });
    expect(mocks.getOrCreateSession).not.toHaveBeenCalled();
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

  it('skips a scheduled kickoff completed before the turn lock', async () => {
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

    // A concurrent submit completed its kickoff first. The re-check under the
    // turn lock sees its terminal output and skips duplicate inference.
    mocks.dbSelectLimit.mockResolvedValue([{ id: 'message-1' }]);
    await scheduled?.();

    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs a scheduled kickoff that has no terminal output at the turn lock', async () => {
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
        adapter: expect.objectContaining({
          createArtifact: mocks.createConversationArtifact,
        }),
      }),
    );
    // The kickoff is admitted durably with its platform framing, so a
    // restart resumes it as a setup event rather than dropping it.
    const { persistFastAgentInlineHumanTurn } =
      await import('@roomote/sdk/server');
    expect(vi.mocked(persistFastAgentInlineHumanTurn)).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: 'setup-conversation-1' }),
      event: expect.objectContaining({
        type: 'human_follow_up',
        currentMessageId: 'setup-kickoff:setup-conversation-1',
        turnSource: 'platform_event',
        platformEventKind: 'setup',
        platformEventVisibility: 'required',
      }),
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs a re-scheduled kickoff whose row is still pending as a resumption of the earlier attempt', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'setup-conversation-1',
      created: false,
    });
    mocks.dbSelectLimit.mockResolvedValue([]);
    let scheduled: (() => Promise<void>) | undefined;
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockResolvedValue('Welcome');
    const { persistFastAgentInlineHumanTurn } =
      await import('@roomote/sdk/server');
    vi.mocked(persistFastAgentInlineHumanTurn).mockResolvedValueOnce({
      id: 'row-1',
      eventKey: 'key-1',
      resumed: true,
    });

    await startSetupFastSessionCommand(auth, input);
    await scheduled?.();

    // The earlier owner was interrupted after admitting this kickoff; the
    // new run continues its recorded attempt rather than starting over.
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageId: 'setup-kickoff:setup-conversation-1',
        durableAdmission: { eventId: 'row-1' },
        resumedAfterInterruption: true,
      }),
    );
  });

  it('recovers a lost or failed kickoff when no terminal output exists', async () => {
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

  it('does not schedule a second kickoff once the kickoff has terminal output', async () => {
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

  it('uses the replying human as the actor for an automation-owned Session', async () => {
    const automationSession = {
      ...session,
      userId: null,
      ownerAutomation: 'custom_automation',
      surface: 'automation',
      workspaceId: 'automation-1',
    };
    const conversation = {
      surface: 'automation' as const,
      workspaceId: 'automation-1',
      conversationId: 'session-1',
    };
    const release = vi.fn().mockResolvedValue(undefined);
    mocks.findAccessibleSession.mockResolvedValue(automationSession);
    mocks.buildReplyDelivery.mockResolvedValue({
      conversation,
      adapter: { launchTask: mocks.launchTask, postReply: vi.fn() },
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockResolvedValue('Continued');

    await replyToFastSessionCommand(auth, {
      sessionId: automationSession.id,
      text: 'Continue this scheduled run.',
    });

    expect(mocks.buildReplyDelivery).toHaveBeenCalledWith({
      sessionId: automationSession.id,
      userId: 'user-1',
      senderDisplayName: 'User One',
      question: 'Continue this scheduled run.',
    });
    const scheduled = mocks.after.mock.calls[0]?.[0];
    expect(scheduled).toBeTypeOf('function');
    await scheduled?.();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversation,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});

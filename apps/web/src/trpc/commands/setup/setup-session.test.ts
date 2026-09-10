const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  schedule: vi.fn(),
  submit: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../setup-new', () => ({ getSetupNewStatusCommand: mocks.getStatus }));
vi.mock('../fast-sessions', () => ({
  scheduleWebFastAgentTurn: mocks.schedule,
  submitFastSessionUserInputCommand: mocks.submit,
}));
vi.mock('./setup-session-completion', () => ({
  completeConversationalSetupIfReady: mocks.complete,
}));
vi.mock('@/lib/server/setup-funnel-telemetry', () => ({
  recordSetupFunnelMilestones: vi.fn(),
}));
vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentArtifactCreator: vi.fn(),
  LINEAR_ORG_CONNECTION_ROLE: 'organization',
}));
vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  createFastAgentWebTaskLauncher: vi.fn(),
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import {
  db,
  deploymentSettings,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  sessions,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  createSetupNewSetupSession,
  normalizeSetupNewState,
  type AcpRequestUserInputPayload,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { SETUP_STARTER_TASKS } from '@/lib/setup-starter-tasks';
import {
  getOrCreateSetupSessionCommand,
  reconcileSetupPlatformEvents,
  resolveSetupSessionTurnContext,
  scheduleSetupPlatformEvent,
  submitSetupSessionUserInputCommand,
} from './setup-session';

describe('optional setup integration discovery', () => {
  let auth: UserAuthSuccess;
  let sessionId: string;
  let conversationId: string;
  let ts: number;

  async function readState() {
    const [row] = await db
      .select()
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'));
    return normalizeSetupNewState(row?.setupNewState);
  }
  async function context() {
    return (await resolveSetupSessionTurnContext(auth, sessionId))!;
  }
  async function request(payload: AcpRequestUserInputPayload) {
    const row = {
      eventId: `event:${payload.requestId}`,
      turnId: payload.turnId,
      payload,
    };
    await db.insert(fastAgentMessages).values({
      ...row,
      payload: { ...payload },
      conversationId,
      turnSeq: 0,
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      role: 'assistant',
      ts: ts++,
      source: 'web',
    });
    return row;
  }
  async function answeredCategory(
    category: string,
    values: string[],
    resolution: 'submitted' | 'cancelled' = 'submitted',
  ) {
    const payload: AcpRequestUserInputPayload = {
      requestId: `category:${category}`,
      sessionId: conversationId,
      turnId: `turn:${category}`,
      callId: category,
      status: 'pending',
      questions: [
        {
          id: `setup-tools-${category}`,
          header: category,
          question: 'Your tools?',
          isOther: true,
          isSecret: false,
        },
      ],
    };
    await request(payload);
    await db.insert(fastAgentMessages).values({
      conversationId,
      eventId: `response:${category}`,
      turnId: payload.turnId,
      turnSeq: 1,
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      role: 'user',
      ts: ts++,
      source: 'web',
      payload: {
        requestId: payload.requestId,
        sessionId: conversationId,
        turnId: payload.turnId,
        callId: category,
        answers: { [`setup-tools-${category}`]: { answers: values } },
        resolution,
      },
    });
  }
  async function continueDiscovery(answer = 'continue') {
    const questions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_integrations');
    const row = await request({
      requestId: 'integrations',
      sessionId: conversationId,
      turnId: 'integrations',
      callId: 'integrations',
      status: 'pending',
      preset: 'setup_integrations',
      questions,
    });
    mocks.submit.mockImplementation(async (_auth, input, options) => {
      await options.persistSetupPresetResponse({
        fastConversationId: conversationId,
        request: row,
        answers: input.answers,
      });
      return { success: true };
    });
    return submitSetupSessionUserInputCommand(auth, {
      sessionId,
      requestId: 'integrations',
      answers: { 'setup-integrations': { answers: [answer] } },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ts = Date.now();
    const user = await userFactory.create({ role: 'admin' });
    auth = { userId: user.id, isAdmin: true } as UserAuthSuccess;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        surface: 'web',
        userId: user.id,
        workspaceId: user.id,
        conversationId: `setup-test:${user.id}`,
      })
      .returning();
    conversationId = conversation!.id;
    const session = await ensureSessionForFastConversation(db, conversationId);
    sessionId = session.id;
    const state = normalizeSetupNewState({
      setupSession: createSetupNewSetupSession({ sessionId }),
    });
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', setupCompletedAt: null, setupNewState: state })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { setupCompletedAt: null, setupNewState: state },
      });
    mocks.getStatus.mockImplementation(async () => ({
      setupNewState: await readState(),
      setupCompletedAt: null,
      modelSetup: { setupSatisfied: true },
      computeSetup: { setupSatisfied: true, providers: [] },
      sourceControlSetup: {
        setupSatisfied: true,
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connected: true,
            repositoryCount: 1,
          },
        ],
      },
    }));
    mocks.complete.mockResolvedValue(true);
  });
  afterEach(async () => {
    await db
      .update(deploymentSettings)
      .set({ setupNewState: normalizeSetupNewState({}) })
      .where(eq(deploymentSettings.id, 'default'));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationId));
    await db.delete(users).where(eq(users.id, auth.userId));
  });

  it('completes zero-match discovery server-side without a browser response', async () => {
    mocks.getStatus.mockImplementation(async () => ({
      setupNewState: await readState(),
      setupCompletedAt: null,
      modelSetup: { setupSatisfied: true },
      computeSetup: { setupSatisfied: false, providers: [] },
      sourceControlSetup: { setupSatisfied: false, providers: [] },
    }));
    const questions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_integrations');
    expect(questions).toEqual([]);
    expect(mocks.schedule).toHaveBeenCalledOnce();
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        platformEventKind: 'setup',
        setupSession: true,
      }),
    );
    expect(
      (await readState()).setupSession?.integrationDiscoveryCompletedAt,
    ).toEqual(expect.any(String));
    expect((await readState()).setupSession?.starterTaskSelection).toBeNull();
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery
        .completed,
    ).toBe(true);
    const responses = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.eventId, 'event:integrations:response'));
    expect(responses).toHaveLength(0);
    await expect(
      (await context()).adapterExtensions.resolveUserInputPreset!(
        'setup_integrations',
      ),
    ).rejects.toThrow('already complete');
  });

  it('persists cancellation as an early skip and completes an empty final match server-side', async () => {
    await answeredCategory('communication', [], 'cancelled');
    const snapshot = JSON.parse(
      (await context()).setupSnapshot,
    ).integrationDiscovery;
    expect(snapshot).toMatchObject({
      skipped: true,
      completed: false,
      matchedIntegrationIds: [],
    });
    await reconcileSetupPlatformEvents(auth);
    expect(mocks.schedule).toHaveBeenCalledOnce();
    const questions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_integrations');
    expect(questions).toEqual([]);
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery
        .completed,
    ).toBe(true);
  });

  it('keeps canonical prose-derived connector matches on the persisted final request across reloads', async () => {
    const questions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_integrations', {
      documents: { answers: ['Granola', 'Google Docs'] },
      'project-tracking': { answers: ['Vercel'] },
    });
    expect(questions[0]?.options?.map((option) => option.id)).toEqual([
      'vercel',
      'granola',
      'continue',
    ]);
    await request({
      requestId: 'prose-tools',
      sessionId: conversationId,
      turnId: 'prose-tools',
      callId: 'prose-tools',
      status: 'pending',
      preset: 'setup_integrations',
      questions,
    });
    const [saved] = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.eventId, 'event:prose-tools'));
    expect(saved?.payload).toMatchObject({
      preset: 'setup_integrations',
      questions: [
        {
          options: [
            { id: 'vercel', label: 'Vercel' },
            { id: 'granola', label: 'Granola' },
            { id: 'continue', label: 'Continue' },
          ],
        },
      ],
    });
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery,
    ).toMatchObject({
      completed: false,
      matchedIntegrationIds: ['vercel', 'granola'],
    });
  });

  it('accepts the legacy continuation label for an existing setup card', async () => {
    await answeredCategory('documents', ['Notion']);
    await expect(continueDiscovery('Continue')).resolves.toEqual({
      success: true,
    });
    expect(
      (await readState()).setupSession?.integrationDiscoveryCompletedAt,
    ).toEqual(expect.any(String));
    const [response] = await db
      .select({ metadata: fastAgentMessages.metadata })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.eventId, 'event:integrations:response'));
    expect(response?.metadata).toMatchObject({ userId: auth.userId });
  });

  it('rejects setup replies from a collaborator instead of dropping setup guards', async () => {
    const collaborator = await userFactory.create({ role: 'admin' });
    const collaboratorAuth = {
      userId: collaborator.id,
      isAdmin: true,
    } as UserAuthSuccess;
    try {
      await expect(
        resolveSetupSessionTurnContext(collaboratorAuth, sessionId),
      ).rejects.toThrow('Only the setup Session owner can reply during setup.');
    } finally {
      await db.delete(users).where(eq(users.id, collaborator.id));
    }
  });

  it('allows normal collaborative context after setup completes', async () => {
    const collaborator = await userFactory.create({ role: 'admin' });
    const collaboratorAuth = {
      userId: collaborator.id,
      isAdmin: true,
    } as UserAuthSuccess;
    await db
      .update(deploymentSettings)
      .set({ setupCompletedAt: new Date() })
      .where(eq(deploymentSettings.id, 'default'));
    try {
      await expect(
        resolveSetupSessionTurnContext(collaboratorAuth, sessionId),
      ).resolves.toBeNull();
    } finally {
      await db.delete(users).where(eq(users.id, collaborator.id));
    }
  });

  it('allows an admin collaborator to resolve a pending setup card after completion', async () => {
    const collaborator = await userFactory.create({ role: 'admin' });
    const collaboratorAuth = {
      userId: collaborator.id,
      isAdmin: true,
    } as UserAuthSuccess;
    await db
      .update(deploymentSettings)
      .set({ setupCompletedAt: new Date() })
      .where(eq(deploymentSettings.id, 'default'));
    mocks.submit.mockResolvedValueOnce({ success: true });
    try {
      await expect(
        submitSetupSessionUserInputCommand(collaboratorAuth, {
          sessionId,
          requestId: 'pending-after-completion',
          answers: {},
        }),
      ).resolves.toEqual({ success: true });
      expect(mocks.submit).toHaveBeenCalledWith(
        collaboratorAuth,
        expect.objectContaining({ requestId: 'pending-after-completion' }),
        expect.objectContaining({ setupSession: true }),
      );
    } finally {
      await db.delete(users).where(eq(users.id, collaborator.id));
    }
  });

  it('resumes persisted category answers and exactly matches catalog options in homepage order', async () => {
    await answeredCategory('communication', ['Discord', 'slack']);
    await answeredCategory('monitoring', ['Grafana', 'Sentry', 'Datadog']);
    const turn = await context();
    const snapshot = JSON.parse(turn.setupSnapshot).integrationDiscovery;
    expect(snapshot.answeredCategoryIds).toEqual(['monitoring']);
    expect(snapshot.unsupportedTools).toEqual(['Datadog']);
    expect(
      snapshot.categories.map((category: { id: string }) => category.id),
    ).toEqual(['documents', 'monitoring', 'project-tracking']);
    const questions = await turn.adapterExtensions.resolveUserInputPreset!(
      'setup_integrations',
      {
        communication: { answers: ['Teams'] },
        documents: { answers: ['notion'] },
        'project-tracking': { answers: ['Jira-like'] },
      },
    );
    expect(questions[0]?.options?.map((option) => option.id)).toEqual([
      'notion',
      'sentry',
      'grafana',
      'continue',
    ]);
    await continueDiscovery();
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery
        .matchedIntegrationIds,
    ).toEqual(['sentry', 'grafana']);
  });

  it('filters provider IDs out of old persisted preset options and new hints', async () => {
    await request({
      requestId: 'legacy-integrations',
      sessionId: conversationId,
      turnId: 'legacy',
      callId: 'legacy',
      status: 'pending',
      preset: 'setup_integrations',
      questions: [
        {
          id: 'setup-integrations',
          header: 'Tools',
          question: 'Your tools?',
          isOther: false,
          isSecret: false,
          options: [
            { id: 'slack', label: 'Slack', description: 'Old provider option' },
            {
              id: 'vercel',
              label: 'Vercel',
              description: 'Old provider option',
            },
            {
              id: 'supabase',
              label: 'Supabase',
              description: 'Eligible connector',
            },
          ],
        },
      ],
    });
    const turn = await context();
    expect(
      JSON.parse(turn.setupSnapshot).integrationDiscovery.matchedIntegrationIds,
    ).toEqual(['vercel', 'supabase']);
    const questions = await turn.adapterExtensions.resolveUserInputPreset!(
      'setup_integrations',
      {
        documents: { answers: ['Slack', 'Vercel', 'Railway'] },
        communication: { answers: ['discord'] },
      },
    );
    expect(questions[0]?.options?.map(({ id }) => id)).toEqual([
      'vercel',
      'supabase',
      'railway',
      'continue',
    ]);
  });

  it('coalesces setup changes into one deterministic turn without discovery-first dropping', async () => {
    expect(await reconcileSetupPlatformEvents(auth)).toBe(true);
    expect(mocks.complete).toHaveBeenCalled();
    expect(
      mocks.schedule.mock.calls.map(
        ([turn]) =>
          JSON.parse(turn.question.replace(/<\/?platform_event>/g, '')).type,
      ),
    ).toEqual(['setup_state_changed']);
    expect(
      JSON.parse(
        mocks.schedule.mock.calls[0]![0].question.replace(
          /<\/?platform_event>/g,
          '',
        ),
      ).changes.map((change: { type: string }) => change.type),
    ).toEqual(['session_creation', 'source_connection', 'starter_request']);
    await answeredCategory('documents', ['Notion']);
    mocks.schedule.mockClear();
    await reconcileSetupPlatformEvents(auth);
    for (const kind of [
      'provider_selection',
      'source_connection',
      'compute_readiness',
      'starter_selection',
      'recommendation_readiness',
    ] as const) {
      expect(
        await scheduleSetupPlatformEvent(auth, {
          kind,
          fingerprint: 'test',
          payload: {},
        }),
      ).toEqual({ scheduled: true });
    }
    expect(mocks.schedule).toHaveBeenCalledTimes(6);
    const starterQuestions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_starter_tasks');
    expect(starterQuestions).toHaveLength(1);
    await continueDiscovery();
    expect(
      mocks.schedule.mock.calls.some(([turn]) =>
        turn.question.includes('starter_request'),
      ),
    ).toBe(true);
    const questions = await (
      await context()
    ).adapterExtensions.resolveUserInputPreset!('setup_starter_tasks');
    expect(questions[0]?.options).toEqual(
      SETUP_STARTER_TASKS.map((task) => ({
        id: task.id,
        label: task.title,
        description: task.description,
      })),
    );
  });

  it('preserves old sessions without retroactively starting optional discovery', async () => {
    const state = await readState();
    delete state.setupSession!.integrationDiscoveryCompletedAt;
    await db
      .update(deploymentSettings)
      .set({ setupNewState: state })
      .where(eq(deploymentSettings.id, 'default'));
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery
        .completed,
    ).toBe(true);
    await expect(getOrCreateSetupSessionCommand(auth)).resolves.toEqual({
      sessionId,
      created: false,
    });
    expect(
      mocks.schedule.mock.calls.some(([turn]) =>
        turn.question.includes('starter_request'),
      ),
    ).toBe(true);
  });

  it('restricts setup continuation and context to its admin owner', async () => {
    await expect(
      submitSetupSessionUserInputCommand(
        { ...auth, isAdmin: false },
        { sessionId, requestId: 'integrations', answers: {} },
      ),
    ).rejects.toThrow('Unauthorized');
    await expect(
      submitSetupSessionUserInputCommand(
        { ...auth, userId: 'other-admin' },
        { sessionId, requestId: 'integrations', answers: {} },
      ),
    ).rejects.toThrow('does not belong');
    await expect(
      resolveSetupSessionTurnContext(
        { ...auth, userId: 'other-admin' },
        sessionId,
      ),
    ).rejects.toThrow('Only the setup Session owner can reply during setup.');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  getStatus: vi.fn(),
  launchTask: vi.fn(),
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
  persistFastAgentInlineHumanTurn: vi.fn().mockResolvedValue(null),
  resolveUserMcpServerConfigs: vi.fn().mockResolvedValue([]),
}));
vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  createFastAgentWebTaskLauncher: vi.fn(() => mocks.launchTask),
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after }));

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
import { registerExclusiveAutomationSettingsDatabaseLock } from '@/testing/exclusive-automation-settings-database-lock';
import {
  getOrCreateSetupSessionCommand,
  reconcileSetupPlatformEvents,
  resolveSetupSessionTurnContext,
  scheduleSetupPlatformEvent,
  skipSetupSourceControlCommand,
  submitSetupSessionUserInputCommand,
} from './setup-session';

registerExclusiveAutomationSettingsDatabaseLock();

describe('optional setup integration discovery', () => {
  let auth: UserAuthSuccess;
  let sessionId: string;
  let conversationId: string;
  let ts: number;
  let actualFastSessions: typeof import('../fast-sessions');

  beforeAll(async () => {
    actualFastSessions = await vi.importActual('../fast-sessions');
  });

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
    ).adapterExtensions!.resolveUserInputPreset!('setup_integrations');
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
    mocks.acquireTurnLock.mockResolvedValue(
      Object.assign(vi.fn().mockResolvedValue(undefined), {
        signal: new AbortController().signal,
      }),
    );
    mocks.launchTask.mockResolvedValue({ taskId: 'starter-task' });
    mocks.answerQuestion.mockImplementation(async ({ question, adapter }) => {
      const payload = JSON.parse(
        question.replace(/<\/?capability_offer_response>/g, ''),
      );
      for (const task of payload.selectedStarterTasks ?? []) {
        await adapter.launchTask({ prompt: task.prompt });
      }
    });
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

  it('offers the compact recommended integrations without a discovery questionnaire', async () => {
    mocks.getStatus.mockImplementation(async () => ({
      setupNewState: await readState(),
      setupCompletedAt: null,
      modelSetup: { setupSatisfied: true },
      computeSetup: { setupSatisfied: false, providers: [] },
      sourceControlSetup: { setupSatisfied: false, providers: [] },
    }));
    await skipSetupSourceControlCommand(auth, sessionId);
    mocks.schedule.mockClear();
    const questions = await (
      await context()
    ).adapterExtensions!.resolveUserInputPreset!('setup_integrations');
    expect(questions).toHaveLength(1);
    expect(questions[0]?.options?.map((option) => option.id)).toEqual([
      'notion',
      'sentry',
      'linear',
      'jira',
      'vercel',
      'continue',
    ]);
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(
      (await readState()).setupSession?.integrationDiscoveryCompletedAt,
    ).toBeNull();
  });

  it('validates capability arguments and allows source control after an initial skip', async () => {
    await expect(
      (await context()).adapterExtensions!.offerCapability!({
        capability: 'integrations',
        message: 'Connect Slack.',
        integrationIds: ['slack'],
      }),
    ).rejects.toThrow('An offered integration was not found.');

    const state = await readState();
    state.setupSession!.sourceControlSkippedAt = '2026-01-01T00:00:00.000Z';
    await db
      .update(deploymentSettings)
      .set({ setupCompletedAt: new Date(), setupNewState: state })
      .where(eq(deploymentSettings.id, 'default'));
    mocks.getStatus.mockImplementation(async () => ({
      setupNewState: await readState(),
      setupCompletedAt: new Date(),
      modelSetup: { setupSatisfied: true },
      computeSetup: { setupSatisfied: true, providers: [] },
      sourceControlSetup: {
        setupSatisfied: false,
        providers: [
          {
            provider: 'gitlab',
            label: 'GitLab',
            connected: false,
            repositoryCount: 0,
          },
        ],
      },
    }));

    const completedContext = await context();
    expect(
      JSON.parse(completedContext.setupSnapshot).initialMilestones
        .source_control,
    ).toBe('declined');
    await expect(
      completedContext.adapterExtensions!.offerCapability!({
        capability: 'source_control',
        message: 'Connect GitLab so I can retrieve the event from your code.',
        provider: 'gitlab',
      }),
    ).resolves.toMatchObject({
      capability: 'source_control',
      provider: 'gitlab',
    });
  });

  it('persists an immutable response and advances only the first setup resolution', async () => {
    const offerId = 'cap:integration-offer';
    await db.insert(fastAgentMessages).values({
      conversationId,
      eventId: 'integration-offer',
      turnId: 'integration-offer-turn',
      turnSeq: 1,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Connect useful tools.' }],
      metadata: { visibleInTranscript: true },
      payload: {
        offerId,
        capability: 'integrations',
        message: 'Connect useful tools.',
        integrationIds: ['notion'],
        status: 'pending',
      },
      source: 'web',
    });
    await actualFastSessions.resolveFastSessionCapabilityOfferCommand(auth, {
      sessionId,
      offerId,
      capability: 'integrations',
      resolution: 'dismissed',
    });
    await actualFastSessions.resolveFastSessionCapabilityOfferCommand(auth, {
      sessionId,
      offerId,
      capability: 'integrations',
      resolution: 'dismissed',
    });

    const responses = await db
      .select({ payload: fastAgentMessages.payload })
      .from(fastAgentMessages)
      .where(
        eq(
          fastAgentMessages.eventType,
          ACP_ENVELOPE_EVENT_TYPES.CapabilityOfferResponse,
        ),
      );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload).toMatchObject({
      offerId,
      capability: 'integrations',
      resolution: 'dismissed',
    });
    expect(
      (await readState()).setupSession?.integrationDiscoveryCompletedAt,
    ).toEqual(expect.any(String));
  });

  it('launches each selected starter task once when the sandbox is ready', async () => {
    const state = await readState();
    state.setupSession!.integrationDiscoveryCompletedAt =
      '2026-01-01T00:00:00.000Z';
    await db
      .update(deploymentSettings)
      .set({ setupNewState: state })
      .where(eq(deploymentSettings.id, 'default'));
    const offerId = 'cap:starter-work';
    await db.insert(fastAgentMessages).values({
      conversationId,
      eventId: 'starter-work-offer',
      turnId: 'starter-work-offer-turn',
      turnSeq: 1,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Choose starter work.' }],
      metadata: { visibleInTranscript: true },
      payload: {
        offerId,
        capability: 'starter_work',
        message: 'Choose starter work.',
        status: 'pending',
      },
      source: 'web',
    });
    await actualFastSessions.resolveFastSessionCapabilityOfferCommand(auth, {
      sessionId,
      offerId,
      capability: 'starter_work',
      resolution: 'completed',
      selectedIds: ['speed-up-ci', 'security-scan'],
    });

    const setupTurn = mocks.schedule.mock.calls.find(([turn]) =>
      turn.question.includes('starter_selection'),
    )?.[0];
    expect(setupTurn).toBeDefined();
    const starterSelection = JSON.parse(
      setupTurn!.question.replace(/<\/?platform_event>/g, ''),
    ).changes.find(
      (change: { type: string }) => change.type === 'starter_selection',
    );
    for (const task of starterSelection.starterTasks) {
      await setupTurn!.delivery.adapter.launchTask({ prompt: task.prompt });
    }
    await mocks.after.mock.calls[0]![0]();

    expect(mocks.launchTask).toHaveBeenCalledTimes(2);
    expect(mocks.launchTask.mock.calls.map(([input]) => input.prompt)).toEqual(
      SETUP_STARTER_TASKS.slice(0, 2).map((task) => task.prompt),
    );
  });

  it('persists source decline, renders its receipt, wakes continuation, and suppresses repository offers', async () => {
    mocks.getStatus.mockImplementation(async () => ({
      setupNewState: await readState(),
      setupCompletedAt: null,
      modelSetup: { setupSatisfied: true },
      computeSetup: { setupSatisfied: false, providers: [] },
      sourceControlSetup: { setupSatisfied: false, providers: [] },
    }));

    await expect(
      skipSetupSourceControlCommand(auth, sessionId),
    ).resolves.toEqual({ success: true });

    expect((await readState()).setupSession?.sourceControlSkippedAt).toEqual(
      expect.any(String),
    );
    const messages = await db
      .select({ payload: fastAgentMessages.payload })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, conversationId));
    expect(
      messages.find(
        ({ payload }) =>
          (payload as { setupReceipt?: { kind?: string } } | null)?.setupReceipt
            ?.kind === 'source_skipped',
      )?.payload,
    ).toMatchObject({
      setupReceipt: {
        presentation: {
          label: 'Skipped source control',
          iconKey: 'git-branch',
        },
      },
    });
    const event = JSON.parse(
      mocks.schedule.mock.calls[0]![0].question.replace(
        /<\/?platform_event>/g,
        '',
      ),
    );
    expect(event.snapshot.sourceControl.skipped).toBe(true);
    expect(
      event.changes.map((change: { type: string }) => change.type),
    ).toEqual(['session_creation', 'source_skipped']);
  });

  it('treats synchronized repositories as superseding an earlier source decline', async () => {
    await skipSetupSourceControlCommand(auth, sessionId);
    mocks.schedule.mockClear();

    await reconcileSetupPlatformEvents(auth);

    const event = JSON.parse(
      mocks.schedule.mock.calls[0]![0].question.replace(
        /<\/?platform_event>/g,
        '',
      ),
    );
    expect(event.snapshot.sourceControl).toMatchObject({
      repositoryCount: 1,
      skipped: false,
    });
    expect(
      event.changes.map((change: { type: string }) => change.type),
    ).toEqual(['session_creation', 'source_connection']);
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
    ).adapterExtensions!.resolveUserInputPreset!('setup_integrations');
    expect(questions).toEqual([]);
    expect(
      JSON.parse((await context()).setupSnapshot).integrationDiscovery
        .completed,
    ).toBe(true);
  });

  it('keeps canonical prose-derived connector matches on the persisted final request across reloads', async () => {
    const questions = await (
      await context()
    ).adapterExtensions!.resolveUserInputPreset!('setup_integrations', {
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
    const messages = await db
      .select({ payload: fastAgentMessages.payload })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, conversationId));
    expect(
      messages.find(
        ({ payload }) =>
          (
            payload as {
              setupReceipt?: { kind?: string };
            } | null
          )?.setupReceipt?.kind === 'integration_discovery',
      )?.payload,
    ).toMatchObject({
      setupReceipt: {
        presentation: {
          label: 'Asked about integrations',
          iconKey: 'plug',
        },
      },
    });
  });

  it('silently closes a replayed integration preset after the offer is resolved', async () => {
    await continueDiscovery();

    await expect(
      (await context()).adapterExtensions!.resolveUserInputPreset!(
        'setup_integrations',
      ),
    ).resolves.toEqual([]);
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

  it('keeps capability context available after setup completes', async () => {
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
      const resolved = await resolveSetupSessionTurnContext(
        collaboratorAuth,
        sessionId,
      );
      expect(resolved).toMatchObject({
        setupSession: false,
        adapterExtensions: { offerCapability: expect.any(Function) },
      });
      expect(resolved!.adapterExtensions!.assertTaskLaunch).toBeUndefined();
      expect(
        resolved!.adapterExtensions!.resolveUserInputPreset,
      ).toBeUndefined();
      expect(JSON.parse(resolved!.setupSnapshot)).toMatchObject({
        recommendedNextCapability: null,
        capabilities: { starter_work: { canOffer: false } },
      });
    } finally {
      await db.delete(users).where(eq(users.id, collaborator.id));
    }
  });

  it.each([
    ['while first work is pending', null],
    ['after setup completes', new Date('2026-01-01T00:00:00.000Z')],
  ])(
    'keeps integration offers but removes setup-only behavior from ordinary admin Sessions %s',
    async (_label, setupCompletedAt) => {
      const [ordinaryConversation] = await db
        .insert(fastAgentConversations)
        .values({
          surface: 'web',
          userId: auth.userId,
          workspaceId: auth.userId,
          conversationId: `ordinary-session:${crypto.randomUUID()}`,
        })
        .returning();
      const ordinarySession = await ensureSessionForFastConversation(
        db,
        ordinaryConversation!.id,
      );
      await db
        .update(deploymentSettings)
        .set({ setupCompletedAt })
        .where(eq(deploymentSettings.id, 'default'));
      mocks.getStatus.mockImplementation(async () => ({
        setupNewState: await readState(),
        setupCompletedAt,
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

      try {
        const resolved = await resolveSetupSessionTurnContext(
          auth,
          ordinarySession.id,
        );
        expect(resolved).toMatchObject({
          setupSession: false,
          adapterExtensions: { offerCapability: expect.any(Function) },
        });
        expect(resolved!.adapterExtensions!.assertTaskLaunch).toBeUndefined();
        expect(
          resolved!.adapterExtensions!.resolveUserInputPreset,
        ).toBeUndefined();
        expect(JSON.parse(resolved!.setupSnapshot)).toMatchObject({
          recommendedNextCapability: null,
          capabilities: {
            integrations: { canOffer: true },
            starter_work: { canOffer: false },
          },
        });
      } finally {
        await db.delete(sessions).where(eq(sessions.id, ordinarySession.id));
        await db
          .delete(fastAgentConversations)
          .where(eq(fastAgentConversations.id, ordinaryConversation!.id));
      }
    },
  );

  it('does not advance onboarding from an integration card in an ordinary Session', async () => {
    const [ordinaryConversation] = await db
      .insert(fastAgentConversations)
      .values({
        surface: 'web',
        userId: auth.userId,
        workspaceId: auth.userId,
        conversationId: `ordinary-offer:${crypto.randomUUID()}`,
      })
      .returning();
    const ordinarySession = await ensureSessionForFastConversation(
      db,
      ordinaryConversation!.id,
    );
    const offerId = 'cap:ordinary-integration-offer';
    await db.insert(fastAgentMessages).values({
      conversationId: ordinaryConversation!.id,
      eventId: 'ordinary-integration-offer',
      turnId: 'ordinary-integration-offer-turn',
      turnSeq: 1,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Connect Notion.' }],
      metadata: { visibleInTranscript: true },
      payload: {
        offerId,
        capability: 'integrations',
        message: 'Connect Notion.',
        integrationIds: ['notion'],
        status: 'pending',
      },
      source: 'web',
    });
    mocks.schedule.mockClear();

    try {
      await actualFastSessions.resolveFastSessionCapabilityOfferCommand(auth, {
        sessionId: ordinarySession.id,
        offerId,
        capability: 'integrations',
        resolution: 'completed',
      });

      const state = await readState();
      expect(state.setupSession?.integrationDiscoveryCompletedAt).toBeNull();
      expect(state.setupSession?.starterTaskSelection).toBeNull();
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(mocks.after).toHaveBeenCalledOnce();
      await mocks.after.mock.calls[0]![0]();
      const turn = mocks.answerQuestion.mock.calls.at(-1)?.[0];
      expect(JSON.parse(turn.setupSnapshot)).toMatchObject({
        recommendedNextCapability: null,
        capabilities: { starter_work: { canOffer: false } },
      });
      expect(turn.adapter.offerCapability).toEqual(expect.any(Function));
      expect(turn.adapter.assertTaskLaunch).toBeUndefined();
    } finally {
      await db.delete(sessions).where(eq(sessions.id, ordinarySession.id));
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, ordinaryConversation!.id));
    }
  });

  it('retains first-work launch gating in the active setup Session', async () => {
    const adapter = (await context()).adapterExtensions!;
    await expect(adapter.assertTaskLaunch!()).rejects.toThrow(
      'Choose your first work before starting a task.',
    );

    const state = await readState();
    state.setupSession!.starterTaskSelection = {
      requestId: 'manual-work',
      taskIds: [],
      selectedAt: new Date().toISOString(),
    };
    await db
      .update(deploymentSettings)
      .set({ setupNewState: state })
      .where(eq(deploymentSettings.id, 'default'));

    await expect(
      (await context()).adapterExtensions!.assertTaskLaunch!(),
    ).resolves.toBeUndefined();
  });

  it('gives non-admin Sessions readiness without callable capability cards', async () => {
    const member = await userFactory.create({ role: 'member' });
    const [memberConversation] = await db
      .insert(fastAgentConversations)
      .values({
        surface: 'web',
        userId: member.id,
        workspaceId: member.id,
        conversationId: `member-session:${member.id}`,
      })
      .returning();
    const memberSession = await ensureSessionForFastConversation(
      db,
      memberConversation!.id,
    );
    // The real status command is admin-only; a member turn must never reach it.
    mocks.getStatus.mockRejectedValue(new Error('Unauthorized'));
    try {
      const resolved = await resolveSetupSessionTurnContext(
        { userId: member.id, isAdmin: false } as UserAuthSuccess,
        memberSession.id,
      );
      expect(mocks.getStatus).not.toHaveBeenCalled();
      expect(resolved?.adapterExtensions).toBeUndefined();
      expect(resolved?.setupSession).toBe(false);
      const snapshot = JSON.parse(resolved!.setupSnapshot);
      expect(snapshot.recommendedNextCapability).toBeNull();
      expect(snapshot.capabilities.integrations).toMatchObject({
        canOffer: false,
        unavailableReason: expect.stringContaining('administrator'),
      });
      expect(snapshot.capabilities.starter_work.canOffer).toBe(false);
    } finally {
      await db.delete(sessions).where(eq(sessions.id, memberSession.id));
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, memberConversation!.id));
      await db.delete(users).where(eq(users.id, member.id));
    }
  });

  it('allows an admin collaborator to resolve a pending setup card after completion', async () => {
    const pendingRequest = await request({
      requestId: 'pending-after-completion',
      sessionId: conversationId,
      turnId: 'pending-after-completion',
      callId: 'pending-after-completion',
      status: 'pending',
      preset: 'setup_integrations',
      questions: [
        {
          id: 'setup-integrations',
          header: 'Your tools',
          question: 'Continue setup?',
          isOther: false,
          isSecret: false,
          options: [
            {
              id: 'continue',
              label: 'Continue',
              description: 'Continue without connections',
            },
          ],
        },
      ],
    });
    const collaborator = await userFactory.create({ role: 'admin' });
    const collaboratorAuth = {
      userId: collaborator.id,
      isAdmin: true,
    } as UserAuthSuccess;
    await db
      .update(deploymentSettings)
      .set({ setupCompletedAt: new Date() })
      .where(eq(deploymentSettings.id, 'default'));
    mocks.submit.mockImplementationOnce(async (_auth, input, options) => {
      await options.persistSetupPresetResponse({
        fastConversationId: conversationId,
        request: pendingRequest,
        answers: input.answers,
      });
      return { success: true };
    });
    try {
      await expect(
        submitSetupSessionUserInputCommand(collaboratorAuth, {
          sessionId,
          requestId: 'pending-after-completion',
          answers: { 'setup-integrations': { answers: ['continue'] } },
        }),
      ).resolves.toEqual({ success: true });
      expect(mocks.submit).toHaveBeenCalledWith(
        collaboratorAuth,
        expect.objectContaining({ requestId: 'pending-after-completion' }),
        expect.objectContaining({ setupSession: true }),
      );
      expect(mocks.schedule).toHaveBeenCalled();
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
    const questions = await turn.adapterExtensions!.resolveUserInputPreset!(
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
    const questions = await turn.adapterExtensions!.resolveUserInputPreset!(
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
    ).toEqual(['session_creation', 'source_connection']);
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
    ).adapterExtensions!.resolveUserInputPreset!('setup_starter_tasks');
    expect(starterQuestions).toHaveLength(1);
    await continueDiscovery();
    expect(
      mocks.schedule.mock.calls.some(([turn]) =>
        turn.question.includes('starter_request'),
      ),
    ).toBe(true);
    const questions = await (
      await context()
    ).adapterExtensions!.resolveUserInputPreset!('setup_starter_tasks');
    expect(questions[0]?.options).toEqual(
      SETUP_STARTER_TASKS.map((task) => ({
        id: task.id,
        label: task.title,
        description: task.description,
      })),
    );
  });

  it('schedules one corrective milestone turn after an applicable offer is missed', async () => {
    await reconcileSetupPlatformEvents(auth);
    const initialTurn = mocks.schedule.mock.calls[0]![0];

    await initialTurn.adapterExtensions.onTurnSettled();

    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule.mock.calls[1]![0].question).toContain(
      'capability_milestone_correction',
    );
    expect(mocks.schedule.mock.calls[1]![0].question).toContain('integrations');
  });

  it('counts every selected launch call as attempted even when launches fail', async () => {
    const state = await readState();
    state.setupSession!.integrationDiscoveryCompletedAt =
      '2026-01-01T00:00:00.000Z';
    state.setupSession!.starterTaskSelection = {
      requestId: 'starter-request',
      taskIds: ['speed-up-ci', 'security-scan'],
      selectedAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await db
      .update(deploymentSettings)
      .set({ setupNewState: state })
      .where(eq(deploymentSettings.id, 'default'));

    await db.insert(fastAgentMessages).values(
      SETUP_STARTER_TASKS.slice(0, 2).map((task, index) => ({
        conversationId,
        eventId: `launch:${index}`,
        turnId: 'starter-launches',
        turnSeq: index,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        role: 'tool' as const,
        ts: Date.now() + index,
        source: 'web' as const,
        payload: {
          toolCallId: `launch:${index}`,
          toolName: 'launch_task',
          status: 'in_progress',
          rawInput: { arguments: { prompt: task.prompt } },
        },
      })),
    );

    await reconcileSetupPlatformEvents(auth);

    expect(mocks.complete).toHaveBeenCalledWith(auth, expect.anything(), [
      'speed-up-ci',
      'security-scan',
    ]);
  });

  it('preserves a manual starter-task continuation across reconciliation', async () => {
    const questions = await (
      await context()
    ).adapterExtensions!.resolveUserInputPreset!('setup_starter_tasks');
    const pendingRequest = await request({
      requestId: 'manual-starter-request',
      sessionId: conversationId,
      turnId: 'manual-starter-request',
      callId: 'manual-starter-request',
      status: 'pending',
      preset: 'setup_starter_tasks',
      questions,
    });
    mocks.submit.mockImplementationOnce(async (_auth, input, options) => {
      await options.persistSetupPresetResponse({
        fastConversationId: conversationId,
        request: pendingRequest,
        answers: input.answers,
      });
      return { success: true };
    });

    await submitSetupSessionUserInputCommand(auth, {
      sessionId,
      requestId: 'manual-starter-request',
      answers: {},
    });

    expect((await readState()).setupSession?.starterTaskSelection).toEqual({
      requestId: 'manual-starter-request',
      taskIds: [],
      selectedAt: expect.any(String),
    });
    mocks.schedule.mockClear();
    await reconcileSetupPlatformEvents(auth);
    expect(
      mocks.schedule.mock.calls.some(([turn]) =>
        turn.question.includes('starter_request'),
      ),
    ).toBe(false);
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

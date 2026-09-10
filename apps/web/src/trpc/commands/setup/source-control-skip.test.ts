import { randomUUID } from 'node:crypto';
import {
  db,
  deploymentSettings,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  sessionFactory,
  sessions,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  createEmptySetupNewState,
  createSetupNewSetupSession,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';

vi.mock('@roomote/cloud-agents/server', () => ({ enqueueTask: vi.fn() }));
vi.mock('@roomote/sdk/server', () => ({
  LINEAR_ORG_CONNECTION_ROLE: 'organization',
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));
vi.mock('@/lib/server/setup-funnel-telemetry', () => ({
  evaluateSetupFunnelMilestones: vi.fn(() => []),
  recordSetupFunnelMilestones: vi.fn(),
}));
vi.mock('@/lib/server', () => ({
  getRepositories: vi.fn(async () => []),
  getSourceControlConnectionSummary: vi.fn(async () => ({
    connectedProviders: [],
    repositoryCounts: {},
  })),
}));
vi.mock('../fast-sessions', () => ({}));
vi.mock('../linked-accounts', () => ({}));
vi.mock('../teams', () => ({}));
vi.mock('../teams/bot-credential-check', () => ({}));
vi.mock('../compute', () => ({
  getPersistedRuntimeComputeConfig: vi.fn(async () => null),
}));
vi.mock('../compute/compute-provisioning', () => ({}));
vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableNames: vi.fn(async () => []),
  getPersistedEnvironmentVariableValues: vi.fn(async () => ({})),
}));
vi.mock('../slack/create-app-from-manifest', () => ({}));
vi.mock('../source-control', () => ({}));
vi.mock('../task-models', () => ({
  getPersistedRawTaskModelSettings: vi.fn(async () => null),
}));
vi.mock('../task-models/models-dev', () => ({}));
vi.mock('../task-models/auto-add-models', () => ({}));
vi.mock('../task-models/provider-validation', () => ({}));
vi.mock('../task-suggestions', () => ({}));
vi.mock('../automations/trigger-agent', () => ({}));
vi.mock('../automations/custom-automations', () => ({}));

import { getSetupNewStatusCommand } from '../setup-new';
import { skipSetupSourceControlCommand } from './setup-session';

describe('durable source-control setup skip', () => {
  let auth: UserAuthSuccess;
  let sessionId: string;
  let conversationId: string;

  beforeEach(async () => {
    vi.stubEnv('ROOMOTE_INFERENCE_API_KEY', '');
    const user = await userFactory.create({});
    auth = { userId: user.id, isAdmin: true } as UserAuthSuccess;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: 'setup-test',
        conversationId: randomUUID(),
      })
      .returning();
    conversationId = conversation!.id;
    const session = await sessionFactory.create({
      fastConversationId: conversationId,
    });
    sessionId = session.id;
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        setupNewState: {
          ...createEmptySetupNewState(),
          setupSession: createSetupNewSetupSession({ sessionId }),
        },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          setupNewState: {
            ...createEmptySetupNewState(),
            setupSession: createSetupNewSetupSession({ sessionId }),
          },
        },
      });
  });

  afterEach(async () => {
    await db
      .delete(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(users).where(eq(users.id, auth.userId));
    vi.unstubAllEnvs();
  });

  it('returns the saved skip on independent status reads without claiming repository readiness', async () => {
    await Promise.all([
      skipSetupSourceControlCommand(auth),
      skipSetupSourceControlCommand(auth),
    ]);
    expect(
      await db
        .select()
        .from(fastAgentMessages)
        .where(eq(fastAgentMessages.conversationId, conversationId)),
    ).toHaveLength(2);
    for (let visit = 0; visit < 2; visit++) {
      expect(await getSetupNewStatusCommand({ ...auth })).toMatchObject({
        sourceControlSkipped: true,
        sourceControlSetup: { setupSatisfied: false },
      });
    }
  });

  it('does not apply a receipt to a different setup Session', async () => {
    await skipSetupSourceControlCommand(auth);
    await db
      .update(deploymentSettings)
      .set({
        setupNewState: {
          ...createEmptySetupNewState(),
          setupSession: createSetupNewSetupSession({ sessionId: randomUUID() }),
        },
      })
      .where(eq(deploymentSettings.id, 'default'));
    expect(await getSetupNewStatusCommand(auth)).toMatchObject({
      sourceControlSkipped: false,
    });
  });

  it('rejects skipping without an owned setup Session instead of reporting a durable success', async () => {
    await db
      .update(deploymentSettings)
      .set({ setupNewState: createEmptySetupNewState() })
      .where(eq(deploymentSettings.id, 'default'));
    await expect(skipSetupSourceControlCommand(auth)).rejects.toThrow(
      'Setup Session not found',
    );
  });

  it('does not reuse a skip from an earlier setup workflow version', async () => {
    await skipSetupSourceControlCommand(auth);
    const setupSession = createSetupNewSetupSession({ sessionId });
    await db
      .update(deploymentSettings)
      .set({
        setupNewState: {
          ...createEmptySetupNewState(),
          setupSession: {
            ...setupSession,
            workflowVersion: setupSession.workflowVersion + 1,
          },
        },
      })
      .where(eq(deploymentSettings.id, 'default'));
    expect(await getSetupNewStatusCommand(auth)).toMatchObject({
      sourceControlSkipped: false,
    });
  });

  it('does not treat transcript text alone as a saved skip', async () => {
    await db.insert(fastAgentMessages).values({
      conversationId,
      eventId: 'ordinary-user-message',
      turnId: 'ordinary-turn',
      turnSeq: 0,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Connect source control later' }],
    });
    expect(await getSetupNewStatusCommand(auth)).toMatchObject({
      sourceControlSkipped: false,
    });
  });

  it("does not expose another admin's skip or permit non-admin skipping", async () => {
    await skipSetupSourceControlCommand(auth);
    expect(
      await getSetupNewStatusCommand({ ...auth, userId: 'another-admin' }),
    ).toMatchObject({ sourceControlSkipped: false });
    await expect(
      skipSetupSourceControlCommand({ ...auth, isAdmin: false }),
    ).rejects.toThrow('Unauthorized');
  });
});

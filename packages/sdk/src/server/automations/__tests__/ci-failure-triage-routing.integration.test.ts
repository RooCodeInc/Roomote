const {
  mockSlackConstructor,
  mockPostMessage,
  mockEnqueueTask,
  mockRedisSet,
  mockClaim,
} = vi.hoisted(() => ({
  mockSlackConstructor: vi.fn(),
  mockPostMessage: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockRedisSet: vi.fn(),
  mockClaim: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({ getRedis: () => ({ set: mockRedisSet }) }));
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  tryClaimCiFailureTriageInvestigation: mockClaim,
  releaseCiFailureTriageInvestigation: vi.fn(),
  buildCiFailureTriageDebounceKey: () => 'ci-triage-integration-debounce',
  buildCiFailureTriageFingerprint: () => 'ci-triage-integration-fingerprint',
  buildCiFailureTriagePrompt: () => '$ci-failure-triage',
  findEnvironmentForRepo: vi.fn(),
  getTaskUrl: () => 'https://app.example.com/task/ci-routing-integration',
}));

// Ownership, destination/payload resolution, and notifier token SQL stay real.
vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();
  return {
    ...actual,
    SlackNotifier: class {
      constructor(token: string) {
        mockSlackConstructor(token);
      }
      postMessage(...args: unknown[]) {
        return mockPostMessage(...args);
      }
      getMessageBlocks = vi.fn().mockResolvedValue([]);
      updateMessage = vi.fn().mockResolvedValue(true);
    },
  };
});

import {
  automations,
  db,
  deploymentSettings,
  environmentFactory,
  environmentRepositoryMappings,
  environments,
  eq,
  getAutomationRuntime,
  repositoryFactory,
  repositories,
  slackInstallationChannels,
  slackInstallationFactory,
  slackInstallations,
  trackedMessages,
  upsertAutomation,
  userFactory,
  users,
} from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '../ci-failure-triage-launch';
import { resolveCiFailureTriageRepositoryDestination } from '../ci-failure-triage-routing';

describe('CI triage Slack ownership through the webhook launch path', () => {
  let userId: string;
  let environmentId: string;
  let repositoryId: string;
  let a: Awaited<ReturnType<typeof slackInstallationFactory.create>>;
  let b: Awaited<ReturnType<typeof slackInstallationFactory.create>>;

  async function configure(
    settings: Record<string, unknown>,
    explicitTarget = true,
  ) {
    await upsertAutomation(db, {
      key: 'ci_failure_triage',
      enabled: true,
      schedule: { mode: 'daily' },
      settings,
      targets: explicitTarget
        ? [
            {
              provider: 'slack',
              targetKind: 'slack_channel',
              externalRef: 'C_FALLBACK',
            },
          ]
        : [],
    });
  }

  async function scope(
    metadata: Record<string, unknown> | null = { teamId: b.teamId },
  ) {
    await configure({
      repositoryRoutes: [
        {
          repositoryIds: [repositoryId],
          target: {
            provider: 'slack',
            targetKind: 'slack_channel',
            externalRef: 'C_OWNER_B',
            ...(metadata === null ? {} : { metadata }),
          },
        },
      ],
    });
  }

  async function launch() {
    return launchCiFailureTriageForFailedRun({
      provider: 'gitlab',
      repositoryId,
      repositoryFullName: 'acme/ci-routing',
      externalRepoId: '9001',
      repositoryHost: 'gitlab.com',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123',
      workflowOrPipelineName: 'CI',
      runId: '42',
      runUrl: 'https://gitlab.com/acme/ci-routing/-/pipelines/42',
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue('1781300000.000100');
    mockEnqueueTask.mockResolvedValue({
      id: 2147483647,
      success: true,
      taskId: 'ci-routing-integration',
    });
    mockRedisSet.mockResolvedValue('OK');
    mockClaim.mockResolvedValue(true);
    // This suite is serialized in sdk-global-db-state, after parallel SDK tests.
    await db.delete(slackInstallations);
    await db.delete(deploymentSettings);
    userId = (await userFactory.create()).id;
    a = await slackInstallationFactory.create({
      installedByUserId: userId,
      botAccessToken: 'xoxb-owner-a',
      isActive: true,
    });
    b = await slackInstallationFactory.create({
      installedByUserId: userId,
      botAccessToken: 'xoxb-owner-b',
      isActive: true,
    });
    await db.insert(slackInstallationChannels).values([
      { slackInstallationId: a.id, channelId: 'C_FALLBACK' },
      { slackInstallationId: b.id, channelId: 'C_OWNER_B' },
    ]);
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', managerSlackChannelId: 'C_FALLBACK' });
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      fullName: 'acme/ci-routing',
      linkedByUserId: userId,
    });
    repositoryId = repository.id;
    environmentId = (
      await environmentFactory.create({ createdByUserId: userId })
    ).id;
    await db
      .insert(environmentRepositoryMappings)
      .values({ environmentId, repositoryId });
    await scope();
  });

  afterEach(async () => {
    await db
      .delete(trackedMessages)
      .where(eq(trackedMessages.automationKey, 'ci_failure_triage'));
    await db
      .delete(automations)
      .where(eq(automations.key, 'ci_failure_triage'));
    await db.delete(deploymentSettings);
    await db.delete(slackInstallations);
    await db.delete(environments).where(eq(environments.id, environmentId));
    await db.delete(repositories).where(eq(repositories.id, repositoryId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('announces with second installation B and enqueues its verified team and thread', async () => {
    expect(await launch()).toMatchObject({
      status: 'ok',
      taskId: 'ci-routing-integration',
    });
    expect(mockSlackConstructor).toHaveBeenCalledExactlyOnceWith(
      'xoxb-owner-b',
    );
    expect(mockPostMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel: 'C_OWNER_B' }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        task: {
          type: 'standard',
          payload: expect.objectContaining({
            teamId: b.teamId,
            channel: 'C_OWNER_B',
            slackChannel: 'C_OWNER_B',
            thread_ts: '1781300000.000100',
            slackThreadTs: '1781300000.000100',
            environmentId,
          }),
        },
        channels: {
          slackChannelId: 'C_OWNER_B',
          slackThreadTs: '1781300000.000100',
        },
      }),
      { launchClass: 'automation' },
    );
  });

  it.each([
    ['missing metadata', null],
    ['missing', {}],
    ['null', { teamId: null }],
    ['number', { teamId: 42 }],
    ['object', { teamId: {} }],
    ['array', { teamId: ['T_OWNER'] }],
    ['blank', { teamId: '' }],
    ['whitespace', { teamId: ' \t' }],
    ['padded', { teamId: ' T_OWNER ' }],
  ])(
    'rejects %s team metadata before Slack or enqueue despite configured fallback',
    async (_name, metadata) => {
      await scope(metadata as Record<string, unknown> | null);
      expect(await launch()).toEqual({
        status: 'ok',
        message: 'Manager channel is not configured',
      });
      expect(mockSlackConstructor).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockEnqueueTask).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockClaim).not.toHaveBeenCalled();
    },
  );

  it.each([
    'stale',
    'deleted',
    'mismatched',
    'padded-matching-team',
    'ambiguous-active',
    'ambiguous-inactive',
    'unmapped',
    'unmapped-sole-active',
  ] as const)(
    'rejects %s ownership before bot selection and enqueue without falling back',
    async (scenario) => {
      if (scenario === 'stale')
        await db
          .update(slackInstallations)
          .set({ isActive: false })
          .where(eq(slackInstallations.id, b.id));
      if (scenario === 'deleted')
        await db
          .delete(slackInstallations)
          .where(eq(slackInstallations.id, b.id));
      if (scenario === 'mismatched') await scope({ teamId: a.teamId });
      if (scenario === 'padded-matching-team')
        await scope({ teamId: ` ${b.teamId} ` });
      if (scenario.startsWith('ambiguous')) {
        await db
          .insert(slackInstallationChannels)
          .values({ slackInstallationId: a.id, channelId: 'C_OWNER_B' });
        if (scenario === 'ambiguous-inactive')
          await db
            .update(slackInstallations)
            .set({ isActive: false })
            .where(eq(slackInstallations.id, a.id));
      }
      if (scenario.startsWith('unmapped')) {
        await db
          .delete(slackInstallationChannels)
          .where(eq(slackInstallationChannels.channelId, 'C_OWNER_B'));
        if (scenario === 'unmapped-sole-active')
          await db
            .update(slackInstallations)
            .set({ isActive: false })
            .where(eq(slackInstallations.id, a.id));
      }
      expect(await launch()).toEqual({
        status: 'ok',
        message: 'Manager channel is not configured',
      });
      expect(mockSlackConstructor).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockEnqueueTask).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockClaim).not.toHaveBeenCalled();
    },
  );

  it('preserves legacy explicit unscoped destination without team using first active bot A', async () => {
    await upsertAutomation(db, {
      key: 'ci_failure_triage',
      enabled: true,
      settings: {},
      targets: [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: 'C_OWNER_B',
        },
      ],
    });
    expect(await launch()).toMatchObject({ taskId: 'ci-routing-integration' });
    expect(mockSlackConstructor).toHaveBeenCalledExactlyOnceWith(
      'xoxb-owner-a',
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_OWNER_B' }),
    );
    expect(mockEnqueueTask.mock.calls[0]?.[0].task.payload).not.toHaveProperty(
      'teamId',
    );
  });

  it('preserves legacy unscoped manager-channel ownership resolution to B', async () => {
    await configure({}, false);
    await db
      .update(deploymentSettings)
      .set({ managerSlackChannelId: 'C_OWNER_B' });
    expect(await launch()).toMatchObject({ taskId: 'ci-routing-integration' });
    expect(mockSlackConstructor).toHaveBeenCalledExactlyOnceWith(
      'xoxb-owner-b',
    );
    expect(mockEnqueueTask.mock.calls[0]?.[0].task.payload.teamId).toBe(
      b.teamId,
    );
  });

  it('preserves the legacy sole-active fallback for an unmapped manager channel', async () => {
    await configure({}, false);
    await db
      .update(deploymentSettings)
      .set({ managerSlackChannelId: 'C_UNMAPPED' });
    await db
      .update(slackInstallations)
      .set({ isActive: false })
      .where(eq(slackInstallations.id, a.id));
    expect(await launch()).toMatchObject({ taskId: 'ci-routing-integration' });
    expect(mockSlackConstructor).toHaveBeenCalledExactlyOnceWith(
      'xoxb-owner-b',
    );
    expect(mockEnqueueTask.mock.calls[0]?.[0].task.payload).toMatchObject({
      teamId: b.teamId,
      channel: 'C_UNMAPPED',
    });
  });

  it('preserves an explicit one-off override but never lets it bypass repository scope', async () => {
    await scope({});
    const runtime = await getAutomationRuntime('ci_failure_triage');
    const destination = {
      provider: 'slack' as const,
      channelId: 'C_ONE_OFF',
      source: 'automation_target' as const,
    };
    expect(
      await resolveCiFailureTriageRepositoryDestination({
        runtime,
        repositoryId,
        connectedProviders: ['slack'],
        destination,
      }),
    ).toEqual(destination);
    expect(
      await resolveCiFailureTriageRepositoryDestination({
        runtime,
        repositoryId: '10000000-0000-4000-8000-000000000001',
        connectedProviders: ['slack'],
        destination,
      }),
    ).toBeNull();
  });
});

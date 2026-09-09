import {
  db,
  eq,
  slackInstallationChannels,
  slackInstallationFactory,
  slackInstallations,
  userFactory,
  users,
} from '@roomote/db/server';
import type { CiFailureTriageRepositoryRoute } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { resolveCiFailureTriageRepositoryRoutes } from '../ci-failure-triage-routing';

const { membership, resolveName } = vi.hoisted(() => ({
  membership:
    vi.fn<(token: string, channel: string) => Promise<boolean | null>>(),
  resolveName: vi.fn<(token: string, name: string) => Promise<string | null>>(),
}));
vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    constructor(private token: string) {}
    isAppInChannel(channel: string) {
      return membership(this.token, channel);
    }
    resolveChannelId(name: string) {
      return resolveName(this.token, name);
    }
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  listConnectedCommunicationProviders: async () => ['slack'],
  findDiscordDestinationByChannelId: vi.fn(),
  resolveAutomationRuntimeDestination: vi.fn(),
}));
vi.mock('@/lib/server/source-control', () => ({
  getRepositories: async () => [
    {
      id: '10000000-0000-4000-8000-000000000001',
      sourceControlProvider: 'github',
    },
  ],
}));

describe('scoped CI Slack ownership at save time', () => {
  let userId: string;
  const channelId = 'C123ROUTE';
  beforeEach(async () => {
    await db.delete(slackInstallations);
    userId = (await userFactory.create()).id;
    membership.mockReset().mockResolvedValue(false);
    resolveName.mockReset().mockResolvedValue(null);
  });
  afterEach(async () => {
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.installedByUserId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });
  const installation = (isActive = true) =>
    slackInstallationFactory.create({ installedByUserId: userId, isActive });
  const map = (slackInstallationId: string) =>
    db
      .insert(slackInstallationChannels)
      .values({ slackInstallationId, channelId });
  const mappings = () =>
    db.query.slackInstallationChannels.findMany({
      where: eq(slackInstallationChannels.channelId, channelId),
    });
  function save(externalRef = channelId, metadata?: Record<string, unknown>) {
    const routes: CiFailureTriageRepositoryRoute[] = [
      {
        repositoryIds: ['10000000-0000-4000-8000-000000000001'],
        target: {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef,
          ...(metadata ? { metadata } : {}),
        },
      },
    ];
    return resolveCiFailureTriageRepositoryRoutes(
      { userId } as UserAuthSuccess,
      routes,
    );
  }

  it('uses only mapped owner B, not first installation A or forged metadata', async () => {
    const first = await installation();
    const owner = await installation();
    await map(owner.id);
    membership.mockResolvedValue(true);
    const result = await save(' c123route ', {
      teamId: first.teamId,
      arbitrary: 'drop',
    });
    expect(result[0]!.target).toEqual({
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: channelId,
      metadata: { teamId: owner.teamId },
    });
    expect(membership.mock.calls).toEqual([[owner.botAccessToken, channelId]]);
    expect(resolveName).not.toHaveBeenCalled();
  });

  it('probes all active installations and persists previously unmapped owner B', async () => {
    const first = await installation();
    const owner = await installation();
    membership.mockImplementation(
      async (token) => token === owner.botAccessToken,
    );
    const result = await save(channelId, { teamId: first.teamId });
    expect(result[0]!.target.metadata).toEqual({ teamId: owner.teamId });
    expect(membership).toHaveBeenCalledWith(first.botAccessToken, channelId);
    expect(membership).toHaveBeenCalledWith(owner.botAccessToken, channelId);
    expect(await mappings()).toEqual([
      expect.objectContaining({ slackInstallationId: owner.id }),
    ]);
    await save(); // UI edits omit metadata; the verified owner remains canonical.
    expect(await mappings()).toHaveLength(1);
  });

  it.each([undefined, { teamId: 42 }, { teamId: '' }, { teamId: 'FORGED' }])(
    'canonicalizes supplied metadata %j without selecting a bot from it',
    async (metadata) => {
      const owner = await installation();
      membership.mockResolvedValue(true);
      expect((await save(channelId, metadata))[0]!.target.metadata).toEqual({
        teamId: owner.teamId,
      });
    },
  );

  it.each([false, null, 'throw'] as const)(
    'rejects a mapped owner membership result of %s',
    async (result) => {
      await installation();
      const owner = await installation();
      await map(owner.id);
      membership.mockImplementation(async () => {
        if (result === 'throw') throw new Error('Slack unavailable');
        return result;
      });
      await expect(save()).rejects.toThrow('Could not verify');
      expect(membership.mock.calls).toEqual([
        [owner.botAccessToken, channelId],
      ]);
    },
  );

  it.each([
    [false, false],
    [true, true],
    [true, null],
    [null, false],
  ] as const)(
    'rejects uncertain or nonunique unmapped membership %j / %j',
    async (a, b) => {
      const first = await installation();
      await installation();
      membership.mockImplementation(async (token) =>
        token === first.botAccessToken ? a : b,
      );
      await expect(save()).rejects.toThrow('Could not verify');
      expect(await mappings()).toEqual([]);
    },
  );

  it('rejects no active installation without probing', async () => {
    await installation(false);
    await expect(save()).rejects.toThrow('Could not verify');
    expect(membership).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'ambiguous'] as const)(
    'rejects %s persisted mappings instead of falling back',
    async (kind) => {
      const first = await installation(kind !== 'inactive');
      const second = await installation();
      await map(first.id);
      if (kind === 'ambiguous') await map(second.id);
      membership.mockResolvedValue(true);
      await expect(save(channelId, { teamId: second.teamId })).rejects.toThrow(
        'ambiguous or inactive',
      );
      expect(membership).not.toHaveBeenCalled();
    },
  );

  it('resolves channel names only with the sole active installation token', async () => {
    await installation(false);
    const owner = await installation();
    resolveName.mockResolvedValue(channelId);
    membership.mockResolvedValue(true);
    expect((await save('#reports'))[0]!.target.metadata).toEqual({
      teamId: owner.teamId,
    });
    expect(resolveName).toHaveBeenCalledWith(owner.botAccessToken, '#reports');
  });

  it('never resolves a name using the first of multiple installations', async () => {
    await installation();
    await installation();
    await expect(save('#reports')).rejects.toThrow('Use a Slack channel ID');
    expect(resolveName).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();
  });

  it.each(['', 'not a channel', '#missing'])(
    'rejects missing or invalid channel input %j',
    async (input) => {
      await installation();
      await expect(save(input)).rejects.toThrow();
      expect(membership).not.toHaveBeenCalled();
      expect(await mappings()).toEqual([]);
    },
  );

  it('rejects a conflicting mapping introduced during the membership probe', async () => {
    const first = await installation();
    const second = await installation();
    membership.mockImplementation(async (token) => {
      if (token !== first.botAccessToken) return false;
      await map(second.id);
      return true;
    });
    await expect(save()).rejects.toThrow('ownership changed');
  });
});

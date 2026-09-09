import { randomUUID } from 'node:crypto';
import {
  slackInstallationFactory,
  slackInstallationChannels,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { resolveCiFailureTriageRules } from '../ci-failure-triage-routing';

const {
  membership,
  model,
  catalog,
  installations,
  mappings,
  insert,
  values,
  onConflictDoNothing,
} = vi.hoisted(() => ({
  membership: vi.fn(),
  model: vi.fn(),
  catalog: vi.fn(),
  installations: vi.fn(),
  mappings: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoNothing: vi.fn(),
}));
// Keep compiler decision tests local; SDK integration tests cover persisted ownership.
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: {
    query: {
      slackInstallations: { findMany: installations },
      slackInstallationChannels: { findMany: mappings },
    },
    insert,
  },
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  generateTrackedNonTaskObject: model,
  NON_TASK_INFERENCE_SURFACES: {
    ciFailureTriageRulesResolution: 'ci_failure_triage_rules_resolution',
  },
}));
vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    constructor(private token: string) {}
    isAppInChannel(channel: string) {
      return membership(this.token, channel);
    }
    listAccessibleChannels() {
      return catalog(this.token);
    }
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  listConnectedCommunicationProviders: async () => ['slack'],
  findDiscordDestinationByChannelId: vi.fn(),
  resolveAutomationRuntimeDestination: vi.fn(),
}));
const backend = '10000000-0000-4000-8000-000000000001';
const platform = '10000000-0000-4000-8000-000000000002';
vi.mock('@/lib/server/source-control', () => ({
  getRepositories: async () => [
    {
      id: '10000000-0000-4000-8000-000000000001',
      fullName: 'acme/backend',
      sourceControlProvider: 'github',
      host: 'github.com',
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      fullName: 'acme/platform',
      sourceControlProvider: 'gitlab',
      host: 'gitlab.example.com',
    },
  ],
}));

describe('CI natural-language rule compilation and Slack ownership', () => {
  const userId = randomUUID();
  let fixtures: Array<
    ReturnType<typeof slackInstallationFactory.build> & { id: string }
  >;
  const text =
    'Only triage backend and platform. Send platform failures to #platform-ci in our Engineering Slack workspace.';
  const channelId = 'C123ROUTE';
  const save = (value = text, settings = {}) =>
    resolveCiFailureTriageRules(
      { userId, isAdmin: true } as UserAuthSuccess,
      value,
      settings,
    );
  const installation = (isActive = true) => {
    const fixture = {
      ...slackInstallationFactory.build({
        installedByUserId: userId,
        isActive,
        teamName: 'Engineering',
      }),
      id: randomUUID(),
    };
    fixtures.push(fixture);
    installations.mockResolvedValue(fixtures);
    return fixture;
  };
  const map = (...owners: ReturnType<typeof installation>[]) =>
    mappings.mockResolvedValue(
      owners.map((owner) => ({
        slackInstallationId: owner.id,
        channelId,
        slackInstallation: owner,
      })),
    );
  const resolution = (workspaceId: string) => ({
    status: 'resolved',
    repositoryIds: [backend, platform],
    destinations: [
      {
        repositoryId: platform,
        destinationId: JSON.stringify(['slack', workspaceId, channelId]),
      },
    ],
    instructions: '',
    clarification: null,
  });
  beforeEach(() => {
    fixtures = [];
    installations.mockReset().mockResolvedValue([]);
    mappings.mockReset().mockResolvedValue([]);
    insert.mockReset().mockReturnValue({ values });
    values.mockReset().mockReturnValue({ onConflictDoNothing });
    onConflictDoNothing.mockReset().mockResolvedValue(undefined);
    membership.mockReset().mockResolvedValue(true);
    catalog
      .mockReset()
      .mockResolvedValue([
        { id: channelId, name: 'platform-ci', isMember: true },
      ]);
    model.mockReset();
  });
  it('compiles the natural language example against provider/host and workspace catalogs, preserving exact owner B', async () => {
    installation();
    const owner = installation();
    map(owner);
    model.mockResolvedValue({ object: resolution(owner.teamId) });
    const rules = await save();
    expect(rules).toEqual({
      text,
      repositoryIds: [backend, platform],
      destinations: [
        {
          repositoryId: platform,
          target: {
            provider: 'slack',
            externalRef: channelId,
            workspaceId: owner.teamId,
          },
        },
      ],
      instructions: '',
    });
    expect(membership.mock.calls).toEqual([[owner.botAccessToken, channelId]]);
    const request = model.mock.calls[0]![0];
    expect(JSON.parse(request.prompt).repositories).toContainEqual(
      expect.objectContaining({
        id: platform,
        provider: 'gitlab',
        host: 'gitlab.example.com',
      }),
    );
    expect(request.system).toContain(
      'never ignore any scope or routing constraint',
    );
  });
  it('probes all installations and inserts only the verified unmapped owner', async () => {
    installation();
    const owner = installation();
    map(owner);
    mappings.mockResolvedValueOnce([]);
    model.mockResolvedValue({ object: resolution(owner.teamId) });
    membership.mockImplementation(
      async (token) => token === owner.botAccessToken,
    );
    await save();
    expect(membership.mock.calls).toEqual(
      fixtures.map((fixture) => [fixture.botAccessToken, channelId]),
    );
    expect(insert).toHaveBeenCalledExactlyOnceWith(slackInstallationChannels);
    expect(values).toHaveBeenCalledExactlyOnceWith({
      slackInstallationId: owner.id,
      channelId,
    });
    expect(onConflictDoNothing).toHaveBeenCalledExactlyOnceWith();
    expect(mappings).toHaveBeenCalledTimes(2);
  });
  it.each([false, null, 'throw'])(
    'rejects uncertain mapped owner membership %s',
    async (result) => {
      const owner = installation();
      map(owner);
      model.mockResolvedValue({ object: resolution(owner.teamId) });
      membership.mockImplementation(async () => {
        if (result === 'throw') throw new Error('Slack unavailable');
        return result;
      });
      await expect(save()).rejects.toThrow('Could not verify');
    },
  );
  it.each([
    [true, true],
    [true, null],
    [false, false],
  ])('rejects nonunique or uncertain unmapped ownership %j', async (a, b) => {
    const first = installation();
    const second = installation();
    model.mockResolvedValue({ object: resolution(first.teamId) });
    membership.mockImplementation(async (token) =>
      token === second.botAccessToken ? b : a,
    );
    await expect(save()).rejects.toThrow('Could not verify');
  });
  it('rejects a conflicting mapping introduced during probing', async () => {
    const first = installation();
    const second = installation();
    map(first, second);
    mappings.mockResolvedValueOnce([]);
    model.mockResolvedValue({ object: resolution(first.teamId) });
    membership.mockImplementation(
      async (token) => token === first.botAccessToken,
    );
    await expect(save()).rejects.toThrow('ownership changed');
  });
  it('rejects inactive and ambiguous mappings and wrong workspace instead of selecting a default', async () => {
    const first = installation();
    const second = installation();
    map(first);
    model.mockResolvedValue({ object: resolution(second.teamId) });
    await expect(save()).rejects.toThrow('another workspace');
    map(first, second);
    await expect(save()).rejects.toThrow('ambiguous or inactive');
    first.isActive = false;
    map(first);
    await expect(save()).rejects.toThrow('ambiguous or inactive');
  });
  it.each([
    {
      status: 'ambiguous',
      repositoryIds: null,
      destinations: [],
      instructions: '',
      clarification: 'Which workspace?',
    },
    {
      status: 'resolved',
      repositoryIds: ['10000000-0000-4000-8000-000000000099'],
      destinations: [],
      instructions: '',
      clarification: null,
    },
    {
      status: 'resolved',
      repositoryIds: [backend, backend],
      destinations: [],
      instructions: '',
      clarification: null,
    },
    {
      status: 'resolved',
      repositoryIds: null,
      destinations: [{ repositoryId: platform, destinationId: 'guessed' }],
      instructions: '',
      clarification: null,
    },
    {
      status: 'resolved',
      repositoryIds: 'all',
      destinations: [],
      instructions: '',
      clarification: null,
    },
  ])('rejects unresolved or invalid model output %j', async (object) => {
    model.mockResolvedValue({ object });
    await expect(save()).rejects.toThrow();
  });
  it('fails save on model failure and skips the model for empty text', async () => {
    model.mockRejectedValue(new Error('Model unavailable'));
    await expect(save()).rejects.toThrow('Model unavailable');
    model.mockClear();
    expect(await save('')).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
  });
  it('keeps all scope for destination-only rules and revalidates unchanged compilation without another inference', async () => {
    const owner = installation();
    map(owner);
    mappings.mockResolvedValueOnce([]);
    model.mockResolvedValue({
      object: {
        ...resolution(owner.teamId),
        repositoryIds: null,
        instructions: 'Keep reports concise.',
      },
    });
    const rules = await save(
      'Send platform failures to #platform-ci. Keep reports concise.',
    );
    expect(rules?.repositoryIds).toBeNull();
    await save(rules!.text, {
      additionalRules: rules!.text,
      compiledRules: rules,
    });
    expect(model).toHaveBeenCalledTimes(1);
    catalog.mockResolvedValue([]);
    await expect(
      save(rules!.text, { additionalRules: rules!.text, compiledRules: rules }),
    ).rejects.toThrow('no longer available');
  });
});

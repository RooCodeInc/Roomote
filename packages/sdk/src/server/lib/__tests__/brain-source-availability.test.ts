const mocks = vi.hoisted(() => ({
  findConnection: vi.fn(),
  findDiscordInstallation: vi.fn(),
  findEnablement: vi.fn(),
  findSlackInstallation: vi.fn(),
  hasGithubSources: vi.fn(),
  resolveDiscordCredentials: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    query: {
      deploymentMcpEnablements: { findFirst: mocks.findEnablement },
      discordInstallations: { findFirst: mocks.findDiscordInstallation },
      mcpConnections: { findFirst: mocks.findConnection },
      slackInstallations: { findFirst: mocks.findSlackInstallation },
    },
  },
  deploymentMcpEnablements: { enabled: {}, mcpId: {} },
  discordInstallations: { isActive: {} },
  eq: vi.fn(),
  isNull: vi.fn(),
  mcpConnections: {
    authStatus: {},
    enabled: {},
    mcpId: {},
    userId: {},
  },
  slackInstallations: { isActive: {} },
  resolveDiscordRuntimeCredentials: mocks.resolveDiscordCredentials,
}));

vi.mock('../brain-github', () => ({
  hasBrainGithubSources: mocks.hasGithubSources,
}));

import type { BrainSourceRequirement } from '@roomote/types';

import {
  findBrainSourceConnectionConfig,
  isBrainSourceAvailable,
  resolveBrainSourceRequirements,
} from '../brain-source-availability';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveBrainSourceRequirements', () => {
  it('resolves every reported source through the collector availability policy', async () => {
    const availability: Record<BrainSourceRequirement, boolean> = {
      github: true,
      discord: true,
      granola: false,
      notion: true,
      rippling: false,
      slack: true,
    };
    const resolveRequirement = vi.fn(
      async (requirement: BrainSourceRequirement) => availability[requirement],
    );

    await expect(
      resolveBrainSourceRequirements(resolveRequirement),
    ).resolves.toEqual(availability);
    expect(new Set(resolveRequirement.mock.calls.flat())).toEqual(
      new Set<BrainSourceRequirement>([
        'github',
        'discord',
        'granola',
        'notion',
        'rippling',
        'slack',
      ]),
    );
  });
});

describe('findBrainSourceConnectionConfig', () => {
  it('requires deployment enablement for Notion', async () => {
    mocks.findConnection.mockResolvedValue({
      authConfig: { type: 'notion', encryptedToken: 'encrypted' },
    });
    mocks.findEnablement.mockResolvedValue(null);

    await expect(findBrainSourceConnectionConfig('notion')).resolves.toBeNull();

    mocks.findEnablement.mockResolvedValue({ mcpId: 'notion' });
    await expect(findBrainSourceConnectionConfig('notion')).resolves.toEqual({
      type: 'notion',
      encryptedToken: 'encrypted',
    });
  });

  it('does not require separate deployment enablement for Granola', async () => {
    mocks.findConnection.mockResolvedValue({
      authConfig: { type: 'granola', encryptedApiKey: 'encrypted' },
    });

    await expect(findBrainSourceConnectionConfig('granola')).resolves.toEqual({
      type: 'granola',
      encryptedApiKey: 'encrypted',
    });
    expect(mocks.findEnablement).not.toHaveBeenCalled();
  });

  it('rejects a connection whose stored config does not match the source', async () => {
    mocks.findConnection.mockResolvedValue({
      authConfig: { type: 'granola', encryptedApiKey: 'encrypted' },
    });
    mocks.findEnablement.mockResolvedValue({ mcpId: 'rippling' });

    await expect(
      findBrainSourceConnectionConfig('rippling'),
    ).resolves.toBeNull();
  });
});

describe('isBrainSourceAvailable', () => {
  it('uses the validated shared connection policy for MCP-backed sources', async () => {
    mocks.findConnection.mockResolvedValue({
      authConfig: { type: 'notion', encryptedToken: 'encrypted' },
    });
    mocks.findEnablement.mockResolvedValue({ mcpId: 'notion' });

    await expect(isBrainSourceAvailable('notion')).resolves.toBe(true);
  });

  it('uses the shared Slack and GitHub readiness checks', async () => {
    mocks.findSlackInstallation.mockResolvedValue({ id: 'installation-id' });
    mocks.hasGithubSources.mockResolvedValue(true);

    await expect(isBrainSourceAvailable('slack')).resolves.toBe(true);
    await expect(isBrainSourceAvailable('github')).resolves.toBe(true);
  });

  it('requires Discord credentials and an active guild installation', async () => {
    mocks.resolveDiscordCredentials.mockResolvedValue({ botToken: 'token' });
    mocks.findDiscordInstallation.mockResolvedValue({ id: 'installation-id' });

    await expect(isBrainSourceAvailable('discord')).resolves.toBe(true);

    mocks.findDiscordInstallation.mockResolvedValue(null);
    await expect(isBrainSourceAvailable('discord')).resolves.toBe(false);
  });
});

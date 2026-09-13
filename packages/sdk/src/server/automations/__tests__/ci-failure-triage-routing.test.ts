import type { CommunicationProvider } from '@roomote/types';
import {
  isCiFailureTriageRepositoryEnabled,
  resolveAutomationRepositoryDestination,
} from '../ci-failure-triage-routing';

const { getRuntime, discord, teams, telegram, fallback } = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  discord: vi.fn(),
  teams: vi.fn(),
  telegram: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock('@roomote/db/server', () => ({
  getAutomationRuntime: getRuntime,
  findActiveSlackInstallationForChannel: vi.fn(),
  db: {
    query: {
      teamsInstallations: { findMany: teams },
      fastAgentConversations: { findFirst: telegram },
    },
  },
  teamsInstallations: {
    conversationId: 'conversation',
    tenantId: 'tenant',
    isActive: 'active',
  },
  fastAgentConversations: {
    surface: 'surface',
    workspaceId: 'workspace',
    currentReplyChannelId: 'channel',
    replyTargetVerified: 'verified',
  },
  eq: (left: unknown, right: unknown) => [left, right],
  and: (...args: unknown[]) => args,
}));
vi.mock('../../lib/discord-persistence', () => ({
  findDiscordDestinationByChannelId: discord,
}));
vi.mock('../destination', () => ({
  resolveAutomationRuntimeDestination: fallback,
}));
const repositoryId = '10000000-0000-4000-8000-000000000001';
function params(
  provider: CommunicationProvider,
): Parameters<typeof resolveAutomationRepositoryDestination>[0] {
  return {
    repositoryId,
    connectedProviders: [provider],
    runtime: {
      destination: null,
      targets: [],
      settings: {
        additionalRules: 'Route backend',
        compiledRules: {
          text: 'Route backend',
          repositoryIds: null,
          instructions: '',
          destinations: [
            {
              repositoryId,
              target: {
                provider,
                externalRef: 'channel',
                workspaceId: 'owner',
              },
            },
          ],
        },
      },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
});
it('revalidates exact Discord guild and channel, never falling back on stale ownership', async () => {
  discord.mockResolvedValue({ guildId: 'other' });
  expect(
    await resolveAutomationRepositoryDestination(params('discord')),
  ).toBeNull();
  expect(discord).toHaveBeenCalledWith('channel');
  discord.mockResolvedValue({ guildId: 'owner' });
  expect(
    await resolveAutomationRepositoryDestination(params('discord')),
  ).toMatchObject({ provider: 'discord', channelId: 'channel' });
  expect(fallback).not.toHaveBeenCalled();
});
it('resolves Teams only against the exact active tenant and conversation', async () => {
  teams.mockResolvedValue([{ serviceUrl: 'https://teams.example' }]);
  expect(
    await resolveAutomationRepositoryDestination(params('teams')),
  ).toMatchObject({ provider: 'teams', serviceUrl: 'https://teams.example' });
  expect(teams).toHaveBeenCalledWith({
    where: [
      ['conversation', 'channel'],
      ['tenant', 'owner'],
      ['active', true],
    ],
  });
  for (const rows of [
    [],
    [{ serviceUrl: null }],
    [{ serviceUrl: 'a' }, { serviceUrl: 'b' }],
  ]) {
    teams.mockResolvedValue(rows);
    expect(
      await resolveAutomationRepositoryDestination(params('teams')),
    ).toBeNull();
  }
  expect(fallback).not.toHaveBeenCalled();
});
it('requires an exact verified Telegram workspace/chat record', async () => {
  telegram.mockResolvedValue(null);
  expect(
    await resolveAutomationRepositoryDestination(params('telegram')),
  ).toBeNull();
  telegram.mockResolvedValue({ id: 'known' });
  expect(
    await resolveAutomationRepositoryDestination(params('telegram')),
  ).toMatchObject({ provider: 'telegram', channelId: 'channel' });
  expect(telegram).toHaveBeenCalledWith({
    where: [
      ['surface', 'telegram'],
      ['workspace', 'owner'],
      ['channel', 'channel'],
      ['verified', true],
    ],
  });
  expect(fallback).not.toHaveBeenCalled();
});
it('does not fall back or query disconnected override providers', async () => {
  expect(
    await resolveAutomationRepositoryDestination({
      ...params('discord'),
      connectedProviders: [],
    }),
  ).toBeNull();
  expect(discord).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});
it('gates webhook evidence fetches with the same compiled scope parser', async () => {
  getRuntime.mockResolvedValue({
    enabled: true,
    scheduleMode: 'daily',
    settings: {},
  });
  expect(await isCiFailureTriageRepositoryEnabled(repositoryId)).toBe(true);
  getRuntime.mockResolvedValue({
    enabled: true,
    scheduleMode: 'daily',
    settings: { additionalRules: 'Only backend' },
  });
  expect(await isCiFailureTriageRepositoryEnabled(repositoryId)).toBe(false);
  getRuntime.mockResolvedValue({
    enabled: false,
    scheduleMode: 'daily',
    settings: {},
  });
  expect(await isCiFailureTriageRepositoryEnabled(repositoryId)).toBe(false);
});

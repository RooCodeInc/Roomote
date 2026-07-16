import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deploymentSettingsFindFirstMock,
  deploymentSettingsUpdateSetMock,
  deploymentSettingsUpdateWhereMock,
  resolveEffectiveDeploymentEnvVarsMock,
} = vi.hoisted(() => ({
  deploymentSettingsFindFirstMock: vi.fn(),
  deploymentSettingsUpdateSetMock: vi.fn(),
  deploymentSettingsUpdateWhereMock: vi.fn(),
  resolveEffectiveDeploymentEnvVarsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: deploymentSettingsFindFirstMock },
    },
    update: vi.fn(() => ({ set: deploymentSettingsUpdateSetMock })),
  },
}));

vi.mock('./model-runtime-config', () => ({
  resolveEffectiveDeploymentEnvVars: resolveEffectiveDeploymentEnvVarsMock,
}));

import {
  DiscordBotTokenValidationError,
  invalidateDiscordRuntimeCredentialsCache,
  normalizeDiscordBotToken,
  resolveDiscordRuntimeCredentials,
  validateDiscordBotToken,
} from './discord-runtime-credentials';

const botResponse = {
  id: '123456789',
  username: 'Roomote',
  global_name: 'Roomote Agent',
  bot: true,
};
const applicationResponse = {
  id: '987654321',
  name: 'Roomote',
  bot: { id: botResponse.id },
};

function mockSuccessfulIdentityFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const value = String(url);
    if (value.endsWith('/users/@me')) {
      return new Response(JSON.stringify(botResponse), { status: 200 });
    }
    if (value.endsWith('/oauth2/applications/@me')) {
      return new Response(JSON.stringify(applicationResponse), { status: 200 });
    }
    throw new Error(`Unexpected Discord URL: ${value}`);
  });
}

describe('Discord runtime credentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    invalidateDiscordRuntimeCredentialsCache();
    process.env.R_DISCORD_BOT_TOKEN = 'discord-token';
    process.env.DISCORD_API_BASE_URL = 'https://discord.example.test/api/v10';
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
    deploymentSettingsFindFirstMock.mockResolvedValue({ metadata: {} });
    deploymentSettingsUpdateSetMock.mockReturnValue({
      where: deploymentSettingsUpdateWhereMock,
    });
    deploymentSettingsUpdateWhereMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('normalizes values copied from an Authorization header', () => {
    expect(normalizeDiscordBotToken('  Bot abc.123.xyz\n')).toBe('abc.123.xyz');
    expect(normalizeDiscordBotToken('   ')).toBeNull();
  });

  it('validates and resolves both the bot and application identities', async () => {
    const fetchMock = mockSuccessfulIdentityFetch();

    await expect(resolveDiscordRuntimeCredentials()).resolves.toEqual({
      botToken: 'discord-token',
      applicationId: applicationResponse.id,
      applicationName: applicationResponse.name,
      botUserId: botResponse.id,
      botUsername: botResponse.username,
      botDisplayName: botResponse.global_name,
      identitySource: 'live',
      identityErrorCode: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.example.test/api/v10/users/@me',
      expect.objectContaining({
        headers: { authorization: 'Bot discord-token' },
      }),
    );
    expect(deploymentSettingsUpdateSetMock).toHaveBeenCalledOnce();
  });

  it('falls back to the encrypted deployment configuration', async () => {
    delete process.env.R_DISCORD_BOT_TOKEN;
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      R_DISCORD_BOT_TOKEN: '  Bot discord-token  ',
    });
    mockSuccessfulIdentityFetch();

    await expect(resolveDiscordRuntimeCredentials()).resolves.toMatchObject({
      botToken: 'discord-token',
      applicationId: applicationResponse.id,
      botUserId: botResponse.id,
    });
    expect(resolveEffectiveDeploymentEnvVarsMock).toHaveBeenCalledOnce();
  });

  it('returns an explicit unconfigured credential state', async () => {
    delete process.env.R_DISCORD_BOT_TOKEN;
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(resolveDiscordRuntimeCredentials()).resolves.toEqual({
      botToken: null,
      applicationId: null,
      applicationName: null,
      botUserId: null,
      botUsername: null,
      botDisplayName: null,
      identitySource: null,
      identityErrorCode: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a fresh token-fingerprinted persistent identity after restart', async () => {
    deploymentSettingsFindFirstMock.mockResolvedValue({
      metadata: {
        discord_bot_info_cache: {
          tokenFingerprint:
            '0017ec88d6aa85df6bc5f77da699b36e05c22ade12611908f1ea8d1919b83271',
          identity: {
            applicationId: applicationResponse.id,
            applicationName: applicationResponse.name,
            botUserId: botResponse.id,
            botUsername: botResponse.username,
            botDisplayName: botResponse.global_name,
          },
          fetchedAtMs: Date.now(),
        },
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(resolveDiscordRuntimeCredentials()).resolves.toMatchObject({
      applicationId: applicationResponse.id,
      botUserId: botResponse.id,
      identitySource: 'persistent_cache',
      identityErrorCode: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports rejected tokens without throwing from runtime resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: '401: Unauthorized' }), {
        status: 401,
      }),
    );

    await expect(resolveDiscordRuntimeCredentials()).resolves.toMatchObject({
      botToken: 'discord-token',
      applicationId: null,
      identitySource: null,
      identityErrorCode: 'unauthorized',
    });
  });

  it('rejects an application whose bot does not match the token identity', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url);
      return value.endsWith('/users/@me')
        ? new Response(JSON.stringify(botResponse), { status: 200 })
        : new Response(
            JSON.stringify({
              ...applicationResponse,
              bot: { id: 'different-bot' },
            }),
            { status: 200 },
          );
    });

    await expect(
      validateDiscordBotToken('discord-token'),
    ).rejects.toMatchObject({
      name: DiscordBotTokenValidationError.name,
      code: 'identity_mismatch',
    });
  });
});

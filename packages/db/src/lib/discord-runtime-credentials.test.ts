import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deploymentSettingsFindFirstMock,
  deploymentSettingsUpdateSetMock,
  deploymentSettingsUpdateWhereMock,
  resolveEffectiveDeploymentEnvVarsMock,
  transactionMock,
  insertValuesMock,
  executeMock,
  environmentVariablesFindFirstMock,
  updateSetMock,
  updateWhereMock,
} = vi.hoisted(() => ({
  deploymentSettingsFindFirstMock: vi.fn(),
  deploymentSettingsUpdateSetMock: vi.fn(),
  deploymentSettingsUpdateWhereMock: vi.fn(),
  resolveEffectiveDeploymentEnvVarsMock: vi.fn(),
  transactionMock: vi.fn(),
  insertValuesMock: vi.fn(),
  executeMock: vi.fn(),
  environmentVariablesFindFirstMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: deploymentSettingsFindFirstMock },
    },
    update: vi.fn(() => ({ set: deploymentSettingsUpdateSetMock })),
    transaction: transactionMock,
    insert: vi.fn(() => ({ values: insertValuesMock })),
    execute: executeMock,
  },
}));

vi.mock('../encryption', () => ({
  decryptSecrets: vi.fn(async (value: string | null) => value),
}));

vi.mock('./model-runtime-config', () => ({
  resolveEffectiveDeploymentEnvVars: resolveEffectiveDeploymentEnvVarsMock,
}));

import {
  DiscordBotTokenValidationError,
  invalidateDiscordRuntimeCredentialsCache,
  normalizeDiscordBotToken,
  resolveDiscordGatewaySecret,
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
    delete process.env.R_DISCORD_GATEWAY_SECRET;
    process.env.DISCORD_API_BASE_URL = 'https://discord.example.test/api/v10';
    resolveEffectiveDeploymentEnvVarsMock.mockReset();
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
    deploymentSettingsFindFirstMock.mockReset();
    deploymentSettingsFindFirstMock.mockResolvedValue({ metadata: {} });
    deploymentSettingsUpdateSetMock.mockReset();
    deploymentSettingsUpdateWhereMock.mockReset();
    deploymentSettingsUpdateSetMock.mockReturnValue({
      where: deploymentSettingsUpdateWhereMock,
    });
    deploymentSettingsUpdateWhereMock.mockResolvedValue(undefined);
    executeMock.mockReset();
    executeMock.mockResolvedValue(undefined);
    insertValuesMock.mockReset();
    insertValuesMock.mockResolvedValue(undefined);
    environmentVariablesFindFirstMock.mockReset();
    environmentVariablesFindFirstMock.mockResolvedValue(undefined);
    updateSetMock.mockReset();
    updateWhereMock.mockReset();
    updateSetMock.mockReturnValue({ where: updateWhereMock });
    updateWhereMock.mockResolvedValue(undefined);
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback) => {
      return callback({
        execute: executeMock,
        query: {
          environmentVariables: {
            findFirst: environmentVariablesFindFirstMock,
          },
        },
        insert: () => ({ values: insertValuesMock }),
        update: () => ({ set: updateSetMock }),
      });
    });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
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

  it('returns process-env gateway secret when present', async () => {
    process.env.R_DISCORD_GATEWAY_SECRET = 'from-env';

    await expect(resolveDiscordGatewaySecret()).resolves.toBe('from-env');
    expect(resolveEffectiveDeploymentEnvVarsMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('returns vault gateway secret when process env is unset', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      R_DISCORD_GATEWAY_SECRET: 'from-vault',
    });

    await expect(resolveDiscordGatewaySecret()).resolves.toBe('from-vault');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('auto-generates and persists a gateway secret when Discord is configured without one', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});

    const secret = await resolveDiscordGatewaySecret();

    expect(secret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'R_DISCORD_GATEWAY_SECRET',
        value: secret,
        userId: null,
      }),
    );
  });

  it('replaces a blank vault gateway secret row instead of failing on unique name', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
    environmentVariablesFindFirstMock.mockResolvedValue({
      id: 'env-row-1',
      value: '   ',
    });

    const secret = await resolveDiscordGatewaySecret();

    expect(secret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: secret,
      }),
    );
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('does not persist a gateway secret when Discord is unconfigured', async () => {
    delete process.env.R_DISCORD_BOT_TOKEN;
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});

    await expect(resolveDiscordGatewaySecret()).resolves.toBeNull();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

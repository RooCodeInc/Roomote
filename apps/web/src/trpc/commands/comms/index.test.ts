import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const {
  mockDbDelete,
  mockTxSelect,
  mockDbTransaction,
  mockUpsertDeploymentEnvironmentVariables,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockResolveEffectiveDeploymentEnvVars,
  mockResolveInvocationIdentities,
  mockResolveTelegramRuntimeCredentials,
  mockTelegramGetWebhookInfo,
  mockTelegramRegisterCommands,
  mockTelegramRegisterWebhook,
} = vi.hoisted(() => ({
  mockDbDelete: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
  mockTxSelect: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn().mockResolvedValue([]),
  mockGetPersistedEnvironmentVariableValues: vi.fn().mockResolvedValue({}),
  mockResolveEffectiveDeploymentEnvVars: vi.fn().mockResolvedValue({}),
  mockResolveInvocationIdentities: vi.fn().mockResolvedValue([]),
  mockResolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: null as string | null,
    webhookSecret: null as string | null,
    botUsername: null as string | null,
  })),
  mockTelegramGetWebhookInfo: vi.fn(),
  mockTelegramRegisterCommands: vi.fn(),
  mockTelegramRegisterWebhook: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    select: mockTxSelect,
    transaction: mockDbTransaction,
    delete: mockDbDelete,
  },
  environmentVariables: { name: 'env.name', userId: 'env.user_id' },
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  resolveEffectiveDeploymentEnvVars: mockResolveEffectiveDeploymentEnvVars,
  resolveInvocationIdentities: mockResolveInvocationIdentities,
  resolveTelegramRuntimeCredentials: mockResolveTelegramRuntimeCredentials,
  normalizeTelegramBotToken: (value: string | null | undefined) => {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.replace(/\s+/g, '');
    return normalized.length > 0 ? normalized : null;
  },
  invalidateTelegramRuntimeCredentialsCache: vi.fn(),
  invalidateSlackSigningSecretCache: vi.fn(),
  invalidateTeamsBotRuntimeCredentialsCache: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials: vi.fn(async () => {
    const { botToken } = await mockResolveTelegramRuntimeCredentials();

    return botToken
      ? {
          getWebhookInfo: mockTelegramGetWebhookInfo,
          registerWebhook: mockTelegramRegisterWebhook,
          registerCommands: mockTelegramRegisterCommands,
        }
      : null;
  }),
}));

vi.mock('@/lib/server/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

vi.mock('../environment-variables', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }
  },
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

import {
  classifyTelegramWebhookCheckError,
  clearCommsAuthConfigCommand,
  getCommsStatusCommand,
  repairTelegramWebhookCommand,
  saveCommsAuthConfigCommand,
} from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'comms-test-user',
    isAdmin: true,
    name: 'Comms Tester',
    primaryEmail: 'comms@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'comms-tester',
      fullName: 'Comms Tester',
      firstName: 'Comms',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'comms@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'comms@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('comms commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelect.mockReset();
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: null,
      webhookSecret: null,
      botUsername: null,
    });
    mockTelegramGetWebhookInfo.mockReset();
  });

  describe('classifyTelegramWebhookCheckError', () => {
    it('identifies rejected bot tokens instead of a generic reachability error', () => {
      expect(
        classifyTelegramWebhookCheckError(
          new Error(
            'Telegram getWebhookInfo failed (401): Unauthorized: invalid token specified',
          ),
        ),
      ).toBe(
        'Telegram rejected the bot token. Check the token from BotFather and save again.',
      );
    });

    it('identifies 404 Not Found responses as rejected bot tokens', () => {
      expect(
        classifyTelegramWebhookCheckError(
          new Error('Telegram getWebhookInfo failed (404): Not Found'),
        ),
      ).toBe(
        'Telegram rejected the bot token. Check the token from BotFather and save again.',
      );
    });

    it('identifies connectivity timeouts', () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      expect(classifyTelegramWebhookCheckError(timeout)).toBe(
        'Could not reach the Telegram Bot API to check the webhook (timed out).',
      );
    });
  });

  describe('getCommsStatusCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        getCommsStatusCommand(buildMockAuth({ isAdmin: false })),
      ).rejects.toThrow('Unauthorized');
    });

    it('returns providers with status from persisted env var names', async () => {
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_SLACK_CLIENT_ID',
        'R_SLACK_CLIENT_SECRET',
        'R_SLACK_SIGNING_SECRET',
      ]);
      mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
        R_SLACK_CLIENT_ID: 'saved-client-id',
      });

      const status = await getCommsStatusCommand(buildMockAuth());

      const slack = status.providers.find((p) => p.id === 'slack');
      expect(slack).toBeDefined();
      expect(slack?.savedSatisfied).toBe(true);
      expect(slack?.setupSatisfied).toBe(true);
      expect(
        slack?.fields.find((field) => field.envVarName === 'R_SLACK_CLIENT_ID'),
      ).toMatchObject({
        savedValue: 'saved-client-id',
      });
      expect(
        slack?.fields.find(
          (field) => field.envVarName === 'R_SLACK_CLIENT_SECRET',
        ),
      ).toMatchObject({
        savedValue: null,
      });
      expect(mockGetPersistedEnvironmentVariableValues).toHaveBeenCalled();
    });

    it('surfaces rejected token reasons on Telegram webhook status', async () => {
      mockResolveTelegramRuntimeCredentials.mockResolvedValue({
        botToken: 'bad-token',
        webhookSecret: 'secret',
        botUsername: null,
      });
      mockTelegramGetWebhookInfo.mockRejectedValue(
        new Error(
          'Telegram getWebhookInfo failed (401): Unauthorized: invalid token specified',
        ),
      );

      const status = await getCommsStatusCommand(buildMockAuth());
      const telegram = status.providers.find((p) => p.id === 'telegram');

      expect(telegram?.telegramWebhook).toEqual({
        status: 'error',
        registeredUrl: null,
        expectedUrl: 'https://app.example.com/api/webhooks/telegram',
        lastErrorMessage:
          'Telegram rejected the bot token. Check the token from BotFather and save again.',
        pendingUpdateCount: 0,
        lastErrorAtMs: null,
      });
    });
  });

  describe('saveCommsAuthConfigCommand', () => {
    it('upserts only non-empty submitted values', async () => {
      process.env.R_SLACK_CLIENT_SECRET = 'env-secret';
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      try {
        await saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'slack',
          values: {
            R_SLACK_CLIENT_ID: 'client-id',
            R_SLACK_CLIENT_SECRET: '  ',
            R_SLACK_SIGNING_SECRET: 'signing-secret',
          },
        });
      } finally {
        delete process.env.R_SLACK_CLIENT_SECRET;
      }

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'comms-test-user',
          values: [
            expect.objectContaining({ name: 'R_SLACK_CLIENT_ID' }),
            expect.objectContaining({ name: 'R_SLACK_SIGNING_SECRET' }),
          ],
        }),
      );
      expect(
        mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]?.values,
      ).toHaveLength(2);
    });

    it('throws when a required field is missing and not satisfied', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'slack',
          values: { R_SLACK_CLIENT_ID: 'client-id' },
        }),
      ).rejects.toThrow(
        'Enter the required Slack configuration values to continue.',
      );

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('does not require fields already satisfied by env', async () => {
      process.env.R_SLACK_CLIENT_ID = 'env-client-id';
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'slack',
          values: {
            R_SLACK_CLIENT_SECRET: 'secret',
            R_SLACK_SIGNING_SECRET: 'signing',
          },
        }),
      ).resolves.toEqual({ telegramWebhook: null });

      delete process.env.R_SLACK_CLIENT_ID;
    });

    it('reports Telegram webhook registration state after saving', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);

      // The mocked credentials resolver returns no token, so registration
      // is reported as failed without touching the Bot API.
      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'telegram',
          values: {
            R_TELEGRAM_BOT_TOKEN: 'bot-token',
          },
        }),
      ).resolves.toEqual({
        telegramWebhook: {
          registered: false,
          error: 'Telegram bot token or webhook secret is not configured.',
        },
      });
    });

    it('auto-generates a Telegram webhook secret when the field is omitted', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'telegram',
        values: {
          R_TELEGRAM_BOT_TOKEN: 'bot-token',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'comms-test-user',
          values: expect.arrayContaining([
            expect.objectContaining({
              name: 'R_TELEGRAM_BOT_TOKEN',
              value: 'bot-token',
            }),
            expect.objectContaining({
              name: 'R_TELEGRAM_WEBHOOK_SECRET',
              value: expect.any(String),
            }),
          ]),
        }),
      );

      const savedValues =
        mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]?.values ??
        [];
      const generatedSecret = savedValues.find(
        (value: { name: string; value: string }) =>
          value.name === 'R_TELEGRAM_WEBHOOK_SECRET',
      )?.value;
      expect(generatedSecret).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('strips whitespace and newlines from the Telegram bot token on save', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'telegram',
        values: {
          R_TELEGRAM_BOT_TOKEN: ' 123:ABC\n ',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            expect.objectContaining({
              name: 'R_TELEGRAM_BOT_TOKEN',
              value: '123:ABC',
            }),
          ]),
        }),
      );
    });
  });

  describe('telegram status', () => {
    it('reflects persisted Telegram values as saved', async () => {
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_TELEGRAM_BOT_TOKEN',
        'R_TELEGRAM_WEBHOOK_SECRET',
      ]);

      const status = await getCommsStatusCommand(buildMockAuth());
      const telegram = status.providers.find((p) => p.id === 'telegram');

      expect(telegram?.savedSatisfied).toBe(true);
      expect(telegram?.setupSatisfied).toBe(true);
      // No bot token resolvable in this test, so no webhook probe runs.
      expect(telegram?.telegramWebhook).toBeNull();
    });

    it('treats Telegram as configured with only a bot token and keeps the secret optional', async () => {
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_TELEGRAM_BOT_TOKEN',
      ]);

      const status = await getCommsStatusCommand(buildMockAuth());
      const telegram = status.providers.find((p) => p.id === 'telegram');
      const webhookSecret = telegram?.fields.find(
        (field) => field.envVarName === 'R_TELEGRAM_WEBHOOK_SECRET',
      );

      expect(telegram?.savedSatisfied).toBe(true);
      expect(telegram?.setupSatisfied).toBe(true);
      expect(webhookSecret?.required).toBe(false);
    });

    it('does not expose a separate Telegram bot username field', async () => {
      mockResolveTelegramRuntimeCredentials.mockResolvedValue({
        botToken: 'token',
        webhookSecret: 'secret',
        botUsername: 'RoomoteBot',
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_TELEGRAM_BOT_TOKEN',
      ]);
      mockTelegramGetWebhookInfo.mockResolvedValue({
        url: 'https://app.example.com/api/webhooks/telegram',
        pendingUpdateCount: 0,
        lastErrorMessage: null,
        lastErrorAtMs: null,
        allowedUpdates: ['message', 'callback_query'],
      });

      const status = await getCommsStatusCommand(buildMockAuth());
      const telegram = status.providers.find((p) => p.id === 'telegram');
      const username = telegram?.fields.find(
        (field) => field.envVarName === 'R_TELEGRAM_BOT_USERNAME',
      );
      const token = telegram?.fields.find(
        (field) => field.envVarName === 'R_TELEGRAM_BOT_TOKEN',
      );

      expect(username).toBeUndefined();
      expect(token?.savedValue).toBeNull();
    });
  });

  it('repairs the webhook and refreshes the slash command menu', async () => {
    mockResolveTelegramRuntimeCredentials.mockResolvedValue({
      botToken: 'token',
      webhookSecret: 'secret',
      botUsername: 'RoomoteBot',
    });

    await expect(
      repairTelegramWebhookCommand(buildMockAuth()),
    ).resolves.toEqual({ repaired: true });
    expect(mockTelegramRegisterWebhook).toHaveBeenCalledWith({
      url: 'https://app.example.com/api/webhooks/telegram',
      secretToken: 'secret',
    });
    expect(mockTelegramRegisterCommands).toHaveBeenCalledOnce();
  });

  describe('clearCommsAuthConfigCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        clearCommsAuthConfigCommand(buildMockAuth({ isAdmin: false }), {
          provider: 'slack',
        }),
      ).rejects.toThrow('Unauthorized');
    });

    it('deletes alternate accepted env var names for the provider fields', async () => {
      const txDelete = vi.fn(() => ({
        where: vi.fn(async () => undefined),
      }));
      const txInArray = (await import('@roomote/db/server')).inArray;

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({ delete: txDelete } as never);
      });

      await clearCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'slack',
      });

      expect(txDelete).toHaveBeenCalled();
      expect(txInArray).toHaveBeenCalledWith(
        'env.name',
        expect.arrayContaining([
          'R_SLACK_CLIENT_ID',
          'R_SLACK_CLIENT_SECRET',
          'R_SLACK_SIGNING_SECRET',
        ]),
      );
    });

    it('clears Microsoft auth and Teams bot env var names together', async () => {
      const txDelete = vi.fn(() => ({
        where: vi.fn(async () => undefined),
      }));
      const txInArray = (await import('@roomote/db/server')).inArray;

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({ delete: txDelete } as never);
      });

      await clearCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'microsoft',
      });

      expect(txDelete).toHaveBeenCalled();
      expect(txInArray).toHaveBeenCalledWith(
        'env.name',
        expect.arrayContaining([
          'R_MICROSOFT_CLIENT_ID',
          'R_MICROSOFT_CLIENT_SECRET',
          'R_MICROSOFT_TENANT_ID',
          'R_TEAMS_BOT_APP_ID',
          'R_TEAMS_BOT_APP_PASSWORD',
          'R_TEAMS_BOT_TENANT_ID',
          'R_TEAMS_BOT_TOKEN_ENDPOINT',
          'R_TEAMS_BOT_OAUTH_SCOPE',
        ]),
      );
    });

    it('saves optional Teams bot fields alongside required Microsoft auth fields', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'microsoft',
          values: {
            R_MICROSOFT_CLIENT_ID: 'ms-client-id',
            R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
            R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
            R_TEAMS_BOT_APP_ID: 'bot-app-id',
            R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
            R_TEAMS_BOT_TENANT_ID: 'bot-tenant-id',
          },
        }),
      ).resolves.toEqual({ telegramWebhook: null });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'comms-test-user',
          values: expect.arrayContaining([
            expect.objectContaining({
              name: 'R_MICROSOFT_CLIENT_ID',
            }),
            expect.objectContaining({
              name: 'R_MICROSOFT_CLIENT_SECRET',
            }),
            expect.objectContaining({ name: 'R_TEAMS_BOT_APP_ID' }),
            expect.objectContaining({ name: 'R_TEAMS_BOT_APP_PASSWORD' }),
            expect.objectContaining({ name: 'R_TEAMS_BOT_TENANT_ID' }),
          ]),
        }),
      );
    });

    it('accepts Microsoft single-app credentials without writing inferred Teams bot vars', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'microsoft',
          values: {
            R_MICROSOFT_CLIENT_ID: 'ms-client-id',
            R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
            R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
          },
        }),
      ).resolves.toEqual({ telegramWebhook: null });

      const savedNames =
        mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]?.values.map(
          (value: { name: string }) => value.name,
        ) ?? [];

      expect(savedNames).toEqual(
        expect.arrayContaining([
          'R_MICROSOFT_CLIENT_ID',
          'R_MICROSOFT_CLIENT_SECRET',
          'R_MICROSOFT_TENANT_ID',
        ]),
      );
      expect(savedNames).not.toEqual(
        expect.arrayContaining([
          'R_TEAMS_BOT_APP_ID',
          'R_TEAMS_BOT_APP_PASSWORD',
          'R_TEAMS_BOT_TENANT_ID',
        ]),
      );
    });
  });
});

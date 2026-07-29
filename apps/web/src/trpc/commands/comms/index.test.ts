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
  mockResolveDiscordRuntimeCredentials,
  mockValidateDiscordBotToken,
  mockValidateTeamsBotCredentials,
  mockDiscordRegisterCommands,
  mockDiscordListGuilds,
  mockDiscordListGuildChannels,
  mockDiscordDiagnoseChannelPermissions,
  mockCaptureDiscordDefaultDestination,
  mockReconcileDiscordInstallations,
  mockSyncDiscordInstallationChannels,
  mockListDiscordInstallations,
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
  mockResolveDiscordRuntimeCredentials: vi.fn(async () => ({
    botToken: null as string | null,
    applicationId: null as string | null,
    applicationName: null as string | null,
    botUserId: null as string | null,
    botUsername: null as string | null,
    botDisplayName: null as string | null,
    identitySource: null as 'live' | 'persistent_cache' | null,
    identityErrorCode: null,
  })),
  mockValidateDiscordBotToken: vi.fn(),
  mockValidateTeamsBotCredentials: vi.fn(async () => undefined),
  mockDiscordRegisterCommands: vi.fn(),
  mockDiscordListGuilds: vi.fn(
    async () =>
      [] as Array<{
        id: string;
        name: string;
        icon: string | null;
        owner?: boolean;
        permissions?: string;
      }>,
  ),
  mockDiscordListGuildChannels: vi.fn(
    async () =>
      [] as Array<{
        id: string;
        guildId?: string;
        parentId?: string;
        name: string;
        type: number;
        position?: number;
        flags?: number;
        availableTags?: Array<{
          id: string;
          name: string;
          moderated: boolean;
          emojiId: string | null;
          emojiName: string | null;
        }>;
      }>,
  ),
  mockDiscordDiagnoseChannelPermissions: vi.fn(),
  mockCaptureDiscordDefaultDestination: vi.fn(),
  mockReconcileDiscordInstallations: vi.fn(),
  mockSyncDiscordInstallationChannels: vi.fn(),
  mockListDiscordInstallations: vi.fn(async () => []),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    select: mockTxSelect,
    transaction: mockDbTransaction,
    delete: mockDbDelete,
    query: {
      discordGatewaySessions: { findFirst: vi.fn(async () => null) },
    },
  },
  discordGatewaySessions: {
    id: 'gateway.id',
    updatedAt: 'gateway.updated_at',
  },
  desc: vi.fn(),
  environmentVariables: { name: 'env.name', userId: 'env.user_id' },
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  like: vi.fn(),
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
  resolveDiscordRuntimeCredentials: mockResolveDiscordRuntimeCredentials,
  resolveDiscordGatewaySecret: vi.fn(async () => 'gateway-secret'),
  validateDiscordBotToken: mockValidateDiscordBotToken,
  normalizeDiscordBotToken: (value: string | null | undefined) =>
    typeof value === 'string'
      ? value
          .trim()
          .replace(/^Bot\s+/i, '')
          .replace(/\s+/g, '') || null
      : null,
  invalidateDiscordRuntimeCredentialsCache: vi.fn(),
  DiscordBotTokenValidationError: class extends Error {},
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ get: vi.fn(async () => null) }),
}));

vi.mock('@roomote/sdk/server', () => ({
  captureDiscordDefaultDestination: mockCaptureDiscordDefaultDestination,
  listDiscordInstallations: mockListDiscordInstallations,
  reconcileDiscordInstallations: mockReconcileDiscordInstallations,
  syncDiscordInstallationChannels: mockSyncDiscordInstallationChannels,
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

vi.mock('@roomote/communication/discord-provider', () => ({
  DiscordCommunicationProvider: class {
    registerCommands = mockDiscordRegisterCommands;
    listGuilds = mockDiscordListGuilds;
    listGuildChannels = mockDiscordListGuildChannels;
    diagnoseChannelPermissions = mockDiscordDiagnoseChannelPermissions;
  },
  discordChannelRequiresTag: (channel: { type: number; flags?: number }) =>
    (channel.type === 15 || channel.type === 16) &&
    ((channel.flags ?? 0) & (1 << 4)) !== 0,
  DISCORD_REQUIRED_TAG_FORUM_ERROR:
    'Discord requires a tag for new posts in this forum, but no tag is available for Roomote to select.',
}));

vi.mock('@roomote/communication/teams-credential-validation', () => ({
  validateTeamsBotCredentials: mockValidateTeamsBotCredentials,
  TeamsBotCredentialValidationError: class TeamsBotCredentialValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly field: string | null = null,
      readonly detail: string | null = null,
    ) {
      super(message);
      this.name = 'TeamsBotCredentialValidationError';
    }
  },
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

import { TeamsBotCredentialValidationError } from '@roomote/communication/teams-credential-validation';

import {
  classifyTelegramWebhookCheckError,
  clearCommsAuthConfigCommand,
  getCommsStatusCommand,
  listDiscordChannelsCommand,
  listDiscordGuildsCommand,
  repairTelegramWebhookCommand,
  saveCommsAuthConfigCommand,
  selectDiscordDestinationCommand,
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
    mockValidateTeamsBotCredentials.mockResolvedValue(undefined);
    mockDiscordListGuilds.mockResolvedValue([]);
    mockDiscordListGuildChannels.mockResolvedValue([]);
    mockDiscordDiagnoseChannelPermissions.mockReset();
    mockCaptureDiscordDefaultDestination.mockReset();
    mockReconcileDiscordInstallations.mockReset();
    mockSyncDiscordInstallationChannels.mockReset();
    mockListDiscordInstallations.mockResolvedValue([]);
    mockResolveDiscordRuntimeCredentials.mockResolvedValue({
      botToken: null,
      applicationId: null,
      applicationName: null,
      botUserId: null,
      botUsername: null,
      botDisplayName: null,
      identitySource: null,
      identityErrorCode: null,
    });
  });

  describe('Discord destinations', () => {
    it('reconciles the complete live guild list for the configured bot identity', async () => {
      mockResolveDiscordRuntimeCredentials.mockResolvedValue({
        botToken: 'discord-token',
        applicationId: 'application-1',
        applicationName: 'Roomote',
        botUserId: 'bot-1',
        botUsername: 'roomote',
        botDisplayName: 'Roomote',
        identitySource: 'live',
        identityErrorCode: null,
      });
      mockDiscordListGuilds.mockResolvedValue([
        { id: 'guild-1', name: 'Engineering', icon: null },
      ]);

      await expect(
        listDiscordGuildsCommand(buildMockAuth()),
      ).resolves.toMatchObject({
        guilds: [{ id: 'guild-1', name: 'Engineering' }],
      });
      expect(mockReconcileDiscordInstallations).toHaveBeenCalledWith({
        applicationId: 'application-1',
        botUserId: 'bot-1',
        installedByUserId: 'comms-test-user',
        guilds: [{ guildId: 'guild-1', guildName: 'Engineering' }],
      });
    });

    beforeEach(() => {
      mockResolveDiscordRuntimeCredentials.mockResolvedValue({
        botToken: 'discord-token',
        applicationId: 'app-1',
        applicationName: 'Roomote',
        botUserId: 'bot-1',
        botUsername: 'roomote',
        botDisplayName: 'Roomote',
        identitySource: 'live',
        identityErrorCode: null,
      });
    });

    it('retains forum flags and tags while supporting required-tag forums', async () => {
      mockDiscordListGuildChannels.mockResolvedValue([
        {
          id: 'forum-1',
          guildId: 'guild-1',
          name: 'tasks',
          type: 15,
          position: 2,
          flags: 1 << 4,
          availableTags: [
            {
              id: 'tag-1',
              name: 'Engineering',
              moderated: false,
              emojiId: null,
              emojiName: '🛠️',
            },
          ],
        },
      ]);

      await expect(
        listDiscordChannelsCommand(buildMockAuth(), { guildId: 'guild-1' }),
      ).resolves.toEqual({
        channels: [
          expect.objectContaining({
            id: 'forum-1',
            flags: 1 << 4,
            requiresTag: true,
            supported: true,
            availableTags: [expect.objectContaining({ id: 'tag-1' })],
          }),
        ],
      });
      expect(mockSyncDiscordInstallationChannels).toHaveBeenCalledOnce();
    });

    it('rejects a required-tag forum only when no tag is available', async () => {
      mockDiscordListGuildChannels.mockResolvedValue([
        {
          id: 'forum-1',
          guildId: 'guild-1',
          name: 'tasks',
          type: 15,
          flags: 1 << 4,
          availableTags: [],
        },
      ]);

      await expect(
        selectDiscordDestinationCommand(buildMockAuth(), {
          guildId: 'guild-1',
          channelId: 'forum-1',
        }),
      ).rejects.toThrow(
        'Discord requires a tag for new posts in this forum, but no tag is available for Roomote to select.',
      );
      expect(mockDiscordDiagnoseChannelPermissions).not.toHaveBeenCalled();
      expect(mockCaptureDiscordDefaultDestination).not.toHaveBeenCalled();
    });
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
    it('validates, saves, and registers a Discord bot token', async () => {
      mockDbTransaction.mockImplementation(async (callback) =>
        callback({} as never),
      );
      mockResolveDiscordRuntimeCredentials.mockResolvedValue({
        botToken: 'discord-token',
        applicationId: 'app-1',
        applicationName: 'Roomote',
        botUserId: 'bot-1',
        botUsername: 'roomote',
        botDisplayName: 'Roomote',
        identitySource: 'live',
        identityErrorCode: null,
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'discord',
          values: { R_DISCORD_BOT_TOKEN: ' Bot discord-token\n' },
        }),
      ).resolves.toMatchObject({
        discord: { registered: true, guildCount: 0, error: null },
      });

      expect(mockValidateDiscordBotToken).toHaveBeenCalledWith('discord-token');
      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            { name: 'R_DISCORD_BOT_TOKEN', value: 'discord-token' },
            expect.objectContaining({
              name: 'R_DISCORD_GATEWAY_SECRET',
              value: expect.any(String),
            }),
          ]),
        }),
      );
      expect(mockDiscordRegisterCommands).toHaveBeenCalledWith({
        applicationId: 'app-1',
      });
    });

    it('auto-generates a Discord gateway secret when omitted on save', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
      mockValidateDiscordBotToken.mockResolvedValue({
        applicationId: 'app-1',
        applicationName: 'Roomote',
        botUserId: 'bot-1',
        botUsername: 'roomote',
        botDisplayName: 'Roomote',
      });
      mockResolveDiscordRuntimeCredentials.mockResolvedValue({
        botToken: 'discord-token',
        applicationId: 'app-1',
        applicationName: 'Roomote',
        botUserId: 'bot-1',
        botUsername: 'roomote',
        botDisplayName: 'Roomote',
        identitySource: 'live',
        identityErrorCode: null,
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'discord',
        values: { R_DISCORD_BOT_TOKEN: 'discord-token' },
      });

      const savedValues =
        mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]?.values ??
        [];
      const generatedSecret = savedValues.find(
        (value: { name: string; value: string }) =>
          value.name === 'R_DISCORD_GATEWAY_SECRET',
      )?.value;
      expect(generatedSecret).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

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

    it('verifies the Teams bot credentials a Microsoft save will produce', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'microsoft',
        values: {
          R_MICROSOFT_CLIENT_ID: 'ms-client-id',
          R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
          R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
        },
      });

      expect(mockValidateTeamsBotCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'ms-client-id',
          appPassword: 'ms-client-secret',
          tenantId: 'ms-tenant-id',
        }),
      );
    });

    it('rejects a Microsoft save when Microsoft rejects the credentials', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockValidateTeamsBotCredentials.mockRejectedValue(
        new TeamsBotCredentialValidationError(
          'invalid_app_password',
          'Microsoft rejected the client secret.',
          'app_password',
          'AADSTS7000215: Invalid client secret provided.',
        ),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'microsoft',
          values: {
            R_MICROSOFT_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
            R_MICROSOFT_CLIENT_SECRET: 'not-a-real-secret',
            R_MICROSOFT_TENANT_ID: '00000000-0000-0000-0000-000000000002',
          },
        }),
      ).rejects.toThrow(
        /Client Secret Value \(R_MICROSOFT_CLIENT_SECRET\).*AADSTS7000215/su,
      );

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('names the dedicated Teams bot field when that credential pair is in use', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockValidateTeamsBotCredentials.mockRejectedValue(
        new TeamsBotCredentialValidationError(
          'invalid_app_id',
          'Microsoft rejected the app (client) id.',
          'app_id',
          "AADSTS700016: Application with identifier 'bot-app-id' was not found in the directory.",
        ),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'microsoft',
          values: {
            R_MICROSOFT_CLIENT_ID: 'ms-client-id',
            R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
            R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
            R_TEAMS_BOT_APP_ID: 'bot-app-id',
            R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
          },
        }),
      ).rejects.toThrow(/Teams Bot App ID \(R_TEAMS_BOT_APP_ID\)/u);

      expect(mockValidateTeamsBotCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'bot-app-id',
          appPassword: 'bot-secret',
        }),
      );
    });

    it('keeps a Microsoft save blocked when Microsoft cannot be reached', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({} as never);
      });
      mockValidateTeamsBotCredentials.mockRejectedValue(
        new TeamsBotCredentialValidationError(
          'unreachable',
          'Could not reach Microsoft to verify the Teams bot credentials (timed out).',
          null,
          'The operation timed out.',
        ),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'microsoft',
          values: {
            R_MICROSOFT_CLIENT_ID: 'ms-client-id',
            R_MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
            R_MICROSOFT_TENANT_ID: 'ms-tenant-id',
          },
        }),
      ).rejects.toThrow(/login\.microsoftonline\.com/u);

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });
  });
});

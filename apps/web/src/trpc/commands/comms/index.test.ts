import { createHash } from 'node:crypto';

import type { UserAuthSuccess } from '@/types';

const {
  mockDbDelete,
  mockTxSelect,
  mockDbTransaction,
  mockResolveAgentMailRuntimeCredentials,
  mockAgentMailClientConstructor,
  mockAgentMailListInboxes,
  mockAgentMailCreateInbox,
  mockAgentMailGetInbox,
  mockAgentMailGetMessage,
  mockAgentMailListWebhooks,
  mockAgentMailCreateWebhook,
  mockAgentMailUpdateWebhook,
  mockAgentMailDeleteWebhook,
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
  mockResolveAgentMailRuntimeCredentials: vi.fn(async () => ({
    apiKey: null as string | null,
    webhookSecret: null as string | null,
    inboxId: null as string | null,
  })),
  mockAgentMailClientConstructor: vi.fn(),
  mockAgentMailListInboxes: vi.fn(),
  mockAgentMailCreateInbox: vi.fn(),
  mockAgentMailGetInbox: vi.fn(),
  mockAgentMailGetMessage: vi.fn(),
  mockAgentMailListWebhooks: vi.fn(),
  mockAgentMailCreateWebhook: vi.fn(),
  mockAgentMailUpdateWebhook: vi.fn(),
  mockAgentMailDeleteWebhook: vi.fn(),
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
  resolveAgentMailRuntimeCredentials: mockResolveAgentMailRuntimeCredentials,
  invalidateAgentMailRuntimeCredentialsCache: vi.fn(),
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

vi.mock('@roomote/communication/agentmail-provider', () => ({
  AgentMailApiClient: class {
    constructor(options: { apiKey: string }) {
      mockAgentMailClientConstructor(options);
    }
    listInboxes = mockAgentMailListInboxes;
    createInbox = mockAgentMailCreateInbox;
    getInbox = mockAgentMailGetInbox;
    getMessage = mockAgentMailGetMessage;
    listWebhooks = mockAgentMailListWebhooks;
    createWebhook = mockAgentMailCreateWebhook;
    updateWebhook = mockAgentMailUpdateWebhook;
    deleteWebhook = mockAgentMailDeleteWebhook;
  },
  AgentMailApiError: class extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'AgentMailApiError';
    }
  },
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
import { AgentMailApiError } from '@roomote/communication/agentmail-provider';

import {
  classifyTelegramWebhookCheckError,
  clearCommsAuthConfigCommand,
  getCommsStatusCommand,
  listAgentMailInboxesCommand,
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
    mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
      apiKey: null,
      webhookSecret: null,
      inboxId: null,
    });
    mockAgentMailListInboxes.mockResolvedValue({ inboxes: [] });
    mockAgentMailListWebhooks.mockResolvedValue({ webhooks: [] });
    mockAgentMailCreateInbox.mockReset();
    mockAgentMailGetInbox.mockReset();
    mockAgentMailCreateWebhook.mockReset();
    mockAgentMailUpdateWebhook.mockReset();
    mockAgentMailDeleteWebhook.mockReset();
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

  describe('agentmail save reconcile', () => {
    const hostHash = createHash('sha256')
      .update('app.example.com')
      .digest('hex')
      .slice(0, 6);
    const expectedUsername = `roomote-app-example-com-${hostHash}`;
    const expectedWebhookUrl = 'https://app.example.com/api/webhooks/agentmail';

    beforeEach(() => {
      mockDbTransaction.mockImplementation(async (callback) =>
        callback({} as never),
      );
      // The message_read capability probe fetches a sentinel message id;
      // 404 is the with-permission answer.
      mockAgentMailGetMessage.mockRejectedValue(
        new AgentMailApiError('AgentMail GET failed (404): Not Found', 404),
      );
    });

    it("adopts the org's only existing inbox instead of creating a second", async () => {
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [{ inbox_id: 'existing@agentmail.to' }],
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        url: expectedWebhookUrl,
        secret: 'whsec_adopted',
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).resolves.toMatchObject({
        agentmail: { inboxAddress: 'existing@agentmail.to' },
      });

      expect(mockAgentMailCreateInbox).not.toHaveBeenCalled();
    });

    it('prefers the inbox email field over the inbox id when adopting', async () => {
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [{ inbox_id: 'inbox_abc123', email: 'Existing@agentmail.to' }],
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        url: expectedWebhookUrl,
        secret: 'whsec_adopted',
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).resolves.toMatchObject({
        agentmail: { inboxAddress: 'existing@agentmail.to' },
      });
    });

    it('fails the save when the key lacks message_read', async () => {
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [{ inbox_id: 'existing@agentmail.to' }],
      });
      mockAgentMailGetMessage.mockRejectedValue(
        new AgentMailApiError('AgentMail GET failed (403): Forbidden', 403),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).rejects.toThrow(/permission|403/i);
      expect(mockAgentMailCreateWebhook).not.toHaveBeenCalled();
    });

    it('asks the operator to choose when the org has several inboxes', async () => {
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [
          { inbox_id: 'one@agentmail.to' },
          { inbox_id: 'two@agentmail.to' },
        ],
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).rejects.toThrow(/2 inboxes.*one@agentmail\.to, two@agentmail\.to/s);
      expect(mockAgentMailCreateInbox).not.toHaveBeenCalled();
    });

    it('names the failing step when a later call is refused', async () => {
      mockAgentMailCreateInbox.mockRejectedValue(
        new Error(
          'AgentMail POST /v0/inboxes failed (403): {"message":"Forbidden"}',
        ),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).rejects.toThrow(
        /refused permission while creating an inbox \(403 Forbidden\)/,
      );
    });

    it('validates the key, provisions an inbox and webhook, and persists the result', async () => {
      mockAgentMailCreateInbox.mockResolvedValue({
        inbox_id: `${expectedUsername}@agentmail.to`,
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        url: expectedWebhookUrl,
        secret: 'whsec_test',
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).resolves.toMatchObject({
        agentmail: {
          inboxAddress: `${expectedUsername}@agentmail.to`,
          webhookUrl: expectedWebhookUrl,
        },
      });

      expect(mockAgentMailListInboxes).toHaveBeenCalledOnce();
      expect(mockAgentMailCreateInbox).toHaveBeenCalledWith({
        username: expectedUsername,
        clientId: `roomote-${hostHash}`,
        displayName: 'Roomote',
      });
      expect(mockAgentMailCreateWebhook).toHaveBeenCalledWith({
        url: expectedWebhookUrl,
        // The client id embeds the deployment host hash so deployments
        // sharing one AgentMail account never adopt each other's webhook.
        clientId: `roomote-agentmail-webhook-${hostHash}`,
        inboxIds: [`${expectedUsername}@agentmail.to`],
        eventTypes: [
          'message.received',
          'message.bounced',
          'message.complained',
        ],
      });
      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            { name: 'R_AGENTMAIL_API_KEY', value: 'am-key' },
            {
              name: 'R_AGENTMAIL_INBOX_ID',
              value: `${expectedUsername}@agentmail.to`,
            },
            { name: 'R_AGENTMAIL_WEBHOOK_SECRET', value: 'whsec_test' },
          ]),
        }),
      );
    });

    it('rejects a bad API key with clear copy and persists nothing', async () => {
      mockAgentMailListInboxes.mockRejectedValue(
        new Error('AgentMail GET /v0/inboxes failed (401): Unauthorized'),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'bad-key' },
        }),
      ).rejects.toThrow(
        /AgentMail rejected this API key\. Create a key in the AgentMail console with these permissions .* webhook_create/,
      );

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('distinguishes network failures from rejected keys', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      mockAgentMailListInboxes.mockRejectedValue(timeout);

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).rejects.toThrow(
        'Could not reach the AgentMail API (timed out). Check connectivity and save again.',
      );

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('adopts an operator-supplied inbox after verifying the key can see it', async () => {
      mockAgentMailGetInbox.mockResolvedValue({
        inbox_id: 'support@agentmail.to',
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        url: expectedWebhookUrl,
        secret: 'whsec_test',
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
        values: {
          R_AGENTMAIL_API_KEY: 'am-key',
          R_AGENTMAIL_INBOX_ID: 'Support@AgentMail.to',
        },
      });

      expect(mockAgentMailGetInbox).toHaveBeenCalledWith(
        'support@agentmail.to',
      );
      expect(mockAgentMailCreateInbox).not.toHaveBeenCalled();
      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            { name: 'R_AGENTMAIL_INBOX_ID', value: 'support@agentmail.to' },
          ]),
        }),
      );
    });

    it('adopts a legacy client-id webhook and re-points it without recreating when a secret is stored', async () => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'support@agentmail.to',
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_AGENTMAIL_API_KEY',
        'R_AGENTMAIL_INBOX_ID',
        'R_AGENTMAIL_WEBHOOK_SECRET',
      ]);
      mockAgentMailGetInbox.mockResolvedValue({
        inbox_id: 'support@agentmail.to',
      });
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            url: 'https://old-deployment.example.com/api/webhooks/agentmail',
            // Pre-hash client id from an earlier release.
            client_id: 'roomote-agentmail-webhook',
            inbox_ids: ['support@agentmail.to'],
          },
        ],
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
        values: { R_AGENTMAIL_INBOX_ID: 'support@agentmail.to' },
      });

      expect(mockAgentMailUpdateWebhook).toHaveBeenCalledWith('wh-1', {
        url: expectedWebhookUrl,
        inboxIds: ['support@agentmail.to'],
        eventTypes: [
          'message.received',
          'message.bounced',
          'message.complained',
        ],
      });
      expect(mockAgentMailCreateWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailDeleteWebhook).not.toHaveBeenCalled();
    });

    it('re-scopes the webhook inbox_ids when the configured inbox changes', async () => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'old-inbox@agentmail.to',
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_AGENTMAIL_API_KEY',
        'R_AGENTMAIL_INBOX_ID',
        'R_AGENTMAIL_WEBHOOK_SECRET',
      ]);
      mockAgentMailGetInbox.mockResolvedValue({
        inbox_id: 'new-inbox@agentmail.to',
      });
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            // URL already matches; only the inbox scoping drifted.
            url: expectedWebhookUrl,
            client_id: `roomote-agentmail-webhook-${hostHash}`,
            inbox_ids: ['old-inbox@agentmail.to'],
          },
        ],
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
        values: { R_AGENTMAIL_INBOX_ID: 'new-inbox@agentmail.to' },
      });

      expect(mockAgentMailUpdateWebhook).toHaveBeenCalledWith('wh-1', {
        url: expectedWebhookUrl,
        inboxIds: ['new-inbox@agentmail.to'],
        eventTypes: [
          'message.received',
          'message.bounced',
          'message.complained',
        ],
      });
      expect(mockAgentMailCreateWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailDeleteWebhook).not.toHaveBeenCalled();
    });

    it('leaves a fully converged webhook untouched', async () => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'support@agentmail.to',
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'R_AGENTMAIL_API_KEY',
        'R_AGENTMAIL_INBOX_ID',
        'R_AGENTMAIL_WEBHOOK_SECRET',
      ]);
      mockAgentMailGetInbox.mockResolvedValue({
        inbox_id: 'support@agentmail.to',
      });
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            url: expectedWebhookUrl,
            client_id: `roomote-agentmail-webhook-${hostHash}`,
            inbox_ids: ['support@agentmail.to'],
            event_types: [
              'message.received',
              'message.bounced',
              'message.complained',
            ],
          },
        ],
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
        values: { R_AGENTMAIL_INBOX_ID: 'support@agentmail.to' },
      });

      expect(mockAgentMailUpdateWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailCreateWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailDeleteWebhook).not.toHaveBeenCalled();
    });

    it("never adopts another deployment's webhook with a different host hash", async () => {
      mockAgentMailGetInbox.mockResolvedValue({
        inbox_id: 'support@agentmail.to',
      });
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-other',
            url: 'https://other-deployment.example.com/api/webhooks/agentmail',
            client_id: 'roomote-agentmail-webhook-ffffff',
            inbox_ids: ['other@agentmail.to'],
          },
        ],
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-mine',
        url: expectedWebhookUrl,
        secret: 'whsec_mine',
      });

      await saveCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
        values: {
          R_AGENTMAIL_API_KEY: 'am-key',
          R_AGENTMAIL_INBOX_ID: 'support@agentmail.to',
        },
      });

      expect(mockAgentMailUpdateWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailDeleteWebhook).not.toHaveBeenCalled();
      expect(mockAgentMailCreateWebhook).toHaveBeenCalledWith({
        url: expectedWebhookUrl,
        clientId: `roomote-agentmail-webhook-${hostHash}`,
        inboxIds: ['support@agentmail.to'],
        eventTypes: [
          'message.received',
          'message.bounced',
          'message.complained',
        ],
      });
    });

    it('creates the proposal inbox when the chooser requests it and it is missing', async () => {
      mockAgentMailGetInbox.mockRejectedValue(
        new Error('AgentMail GET /v0/inboxes/x failed (404): Not Found'),
      );
      mockAgentMailCreateInbox.mockResolvedValue({
        inbox_id: `${expectedUsername}@agentmail.to`,
      });
      mockAgentMailCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        url: expectedWebhookUrl,
        secret: 'whsec_test',
      });

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: {
            R_AGENTMAIL_API_KEY: 'am-key',
            R_AGENTMAIL_INBOX_ID: `${expectedUsername}@agentmail.to`,
          },
        }),
      ).resolves.toMatchObject({
        agentmail: { inboxAddress: `${expectedUsername}@agentmail.to` },
      });

      expect(mockAgentMailCreateInbox).toHaveBeenCalledWith({
        username: expectedUsername,
        clientId: `roomote-${hostHash}`,
        displayName: 'Roomote',
      });
      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            {
              name: 'R_AGENTMAIL_INBOX_ID',
              value: `${expectedUsername}@agentmail.to`,
            },
          ]),
        }),
      );
    });

    it('still rejects a missing inbox that is not the deployment proposal', async () => {
      mockAgentMailGetInbox.mockRejectedValue(
        new Error('AgentMail GET /v0/inboxes/x failed (404): Not Found'),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: {
            R_AGENTMAIL_API_KEY: 'am-key',
            R_AGENTMAIL_INBOX_ID: 'missing@agentmail.to',
          },
        }),
      ).rejects.toThrow(
        /could not find the inbox missing@agentmail\.to with this API key/u,
      );

      expect(mockAgentMailCreateInbox).not.toHaveBeenCalled();
      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('surfaces a taken username inline with guidance to pick an address', async () => {
      mockAgentMailCreateInbox.mockRejectedValue(
        new Error(
          'AgentMail POST /v0/inboxes failed (409): Inbox already exists',
        ),
      );

      await expect(
        saveCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
          values: { R_AGENTMAIL_API_KEY: 'am-key' },
        }),
      ).rejects.toThrow(/already taken at AgentMail/u);

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });
  });

  describe('listAgentMailInboxesCommand', () => {
    const hostHash = createHash('sha256')
      .update('app.example.com')
      .digest('hex')
      .slice(0, 6);
    const proposedNewAddress = `roomote-app-example-com-${hostHash}@agentmail.to`;

    it('rejects non-admin users', async () => {
      await expect(
        listAgentMailInboxesCommand(buildMockAuth({ isAdmin: false }), {}),
      ).rejects.toThrow('Unauthorized');
    });

    it('lists normalized inboxes with the entered key even when one is saved', async () => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'saved-key',
        webhookSecret: null,
        inboxId: null,
      });
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [
          { inbox_id: 'One@AgentMail.to' },
          { inbox_id: 'two@agentmail.to' },
        ],
      });

      await expect(
        listAgentMailInboxesCommand(buildMockAuth(), {
          apiKey: '  typed-key  ',
        }),
      ).resolves.toEqual({
        inboxes: ['one@agentmail.to', 'two@agentmail.to'],
        proposedNewAddress,
      });

      expect(mockAgentMailClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'typed-key' }),
      );
    });

    it('falls back to the saved API key when none is entered', async () => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'saved-key',
        webhookSecret: null,
        inboxId: null,
      });
      mockAgentMailListInboxes.mockResolvedValue({
        inboxes: [{ inbox_id: 'existing@agentmail.to' }],
      });

      await expect(
        listAgentMailInboxesCommand(buildMockAuth(), {}),
      ).resolves.toEqual({
        inboxes: ['existing@agentmail.to'],
        proposedNewAddress,
      });

      expect(mockAgentMailClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'saved-key' }),
      );
    });

    it('errors clearly when no API key is entered or saved', async () => {
      await expect(
        listAgentMailInboxesCommand(buildMockAuth(), {}),
      ).rejects.toThrow(
        'Enter an AgentMail API key to load the account inboxes.',
      );

      expect(mockAgentMailListInboxes).not.toHaveBeenCalled();
    });

    it('classifies a refused key with the required permissions copy', async () => {
      mockAgentMailListInboxes.mockRejectedValue(
        new Error('AgentMail GET /v0/inboxes failed (403): Forbidden'),
      );

      await expect(
        listAgentMailInboxesCommand(buildMockAuth(), { apiKey: 'bad-key' }),
      ).rejects.toThrow(
        /AgentMail rejected this API key\. Create a key in the AgentMail console with these permissions .* webhook_create/,
      );
    });
  });

  describe('agentmail clear', () => {
    it('best-effort deletes the reconciled webhook and removes the secret', async () => {
      const txDelete = vi.fn(() => ({
        where: vi.fn(async () => undefined),
      }));
      const txInArray = (await import('@roomote/db/server')).inArray;
      mockDbTransaction.mockImplementation(async (callback) =>
        callback({ delete: txDelete } as never),
      );
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'support@agentmail.to',
      });
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            url: 'https://app.example.com/api/webhooks/agentmail',
            client_id: 'roomote-agentmail-webhook',
          },
        ],
      });

      await clearCommsAuthConfigCommand(buildMockAuth(), {
        provider: 'agentmail',
      });

      expect(mockAgentMailDeleteWebhook).toHaveBeenCalledWith('wh-1');
      expect(txInArray).toHaveBeenCalledWith(
        'env.name',
        expect.arrayContaining([
          'R_AGENTMAIL_API_KEY',
          'R_AGENTMAIL_INBOX_ID',
          'R_AGENTMAIL_WEBHOOK_SECRET',
        ]),
      );
    });

    it('never fails the disconnect when the webhook delete errors', async () => {
      const txDelete = vi.fn(() => ({
        where: vi.fn(async () => undefined),
      }));
      mockDbTransaction.mockImplementation(async (callback) =>
        callback({ delete: txDelete } as never),
      );
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'support@agentmail.to',
      });
      mockAgentMailListWebhooks.mockRejectedValue(
        new Error('AgentMail GET /v0/webhooks failed (500)'),
      );

      await expect(
        clearCommsAuthConfigCommand(buildMockAuth(), {
          provider: 'agentmail',
        }),
      ).resolves.toBeUndefined();
      expect(txDelete).toHaveBeenCalled();
    });
  });

  describe('agentmail status', () => {
    const expectedWebhookUrl = 'https://app.example.com/api/webhooks/agentmail';

    beforeEach(() => {
      mockResolveAgentMailRuntimeCredentials.mockResolvedValue({
        apiKey: 'am-key',
        webhookSecret: 'whsec_existing',
        inboxId: 'support@agentmail.to',
      });
    });

    it('reports connected when the webhook covers the configured inbox', async () => {
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            url: expectedWebhookUrl,
            client_id: 'roomote-agentmail-webhook',
            inbox_ids: ['support@agentmail.to'],
          },
        ],
      });

      const status = await getCommsStatusCommand(buildMockAuth());
      const agentmail = status.providers.find((p) => p.id === 'agentmail');

      expect(agentmail?.agentmail?.webhook.status).toBe('connected');
    });

    it('reports mismatch when the webhook is scoped to a different inbox', async () => {
      mockAgentMailListWebhooks.mockResolvedValue({
        webhooks: [
          {
            webhook_id: 'wh-1',
            url: expectedWebhookUrl,
            client_id: 'roomote-agentmail-webhook',
            inbox_ids: ['someone-else@agentmail.to'],
          },
        ],
      });

      const status = await getCommsStatusCommand(buildMockAuth());
      const agentmail = status.providers.find((p) => p.id === 'agentmail');

      expect(agentmail?.agentmail?.webhook.status).toBe('mismatch');
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

import { createHash } from 'node:crypto';

import {
  DiscordBotTokenValidationError,
  discordGatewaySessions,
  invalidateDiscordRuntimeCredentialsCache,
  normalizeDiscordBotToken,
  resolveDiscordRuntimeCredentials,
  validateDiscordBotToken,
  resolveTelegramRuntimeCredentials,
  invalidateTelegramRuntimeCredentialsCache,
  invalidateTeamsBotRuntimeCredentialsCache,
  invalidateSlackSigningSecretCache,
  resolveInvocationIdentities,
  normalizeTelegramBotToken,
  db,
  environmentVariables,
  and,
  desc,
  inArray,
  isNull,
  like,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  discordChannelRequiresTag,
  DiscordCommunicationProvider,
  DISCORD_REQUIRED_TAG_FORUM_ERROR,
  type DiscordChannelPermissionDiagnostics,
} from '@roomote/communication/discord-provider';
import { getRedis } from '@roomote/redis';
import {
  captureDiscordDefaultDestination,
  createTelegramCommunicationProviderFromRuntimeCredentials,
  listDiscordInstallations,
  reconcileDiscordInstallations,
  syncDiscordInstallationChannels,
} from '@roomote/sdk/server';

import { Env } from '@/lib/server/env';
import { DISCORD_INSTALL_PERMISSIONS } from '@/lib/discord-install';
import {
  buildSetupAuthStatus,
  getSetupAuthProvider,
  NON_SECRET_AUTH_ENV_VAR_NAMES,
  resolveTeamsBotCredentialEnvVarNames,
  SETUP_AUTH_PROVIDER_IDS,
  type SetupAuthProviderId,
  type SetupAuthStatus,
  type InvocationIdentity,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import {
  assertAdmin,
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';

type AdditionalCommsProviderId = 'telegram' | 'discord';
type CommsProviderId = SetupAuthProviderId | AdditionalCommsProviderId;
export const COMMS_PROVIDER_IDS = [
  ...SETUP_AUTH_PROVIDER_IDS,
  'telegram',
  'discord',
] as const;

type AdditionalCommsProviderDefinition = {
  id: AdditionalCommsProviderId;
  label: string;
  fields: Array<{
    envVarName: string;
    acceptedEnvVarNames: string[];
    label: string;
    secret?: boolean;
    required?: false;
  }>;
};

const ADDITIONAL_COMMS_PROVIDERS: Record<
  AdditionalCommsProviderId,
  AdditionalCommsProviderDefinition
> = {
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    fields: [
      {
        envVarName: 'R_TELEGRAM_BOT_TOKEN',
        acceptedEnvVarNames: ['R_TELEGRAM_BOT_TOKEN'],
        label: 'Telegram Bot Token',
        secret: true,
      },
      {
        envVarName: 'R_TELEGRAM_WEBHOOK_SECRET',
        acceptedEnvVarNames: ['R_TELEGRAM_WEBHOOK_SECRET'],
        label: 'Telegram Webhook Secret',
        secret: true,
        required: false,
      },
    ],
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    fields: [
      {
        envVarName: 'R_DISCORD_BOT_TOKEN',
        acceptedEnvVarNames: ['R_DISCORD_BOT_TOKEN'],
        label: 'Discord Bot Token',
        secret: true,
      },
    ],
  },
};

function isAdditionalCommsProviderId(
  provider: CommsProviderId,
): provider is AdditionalCommsProviderId {
  return provider === 'telegram' || provider === 'discord';
}

function getCommsProviderDefinition(provider: CommsProviderId) {
  return isAdditionalCommsProviderId(provider)
    ? ADDITIONAL_COMMS_PROVIDERS[provider]
    : getSetupAuthProvider(provider);
}

function createTelegramWebhookSecret() {
  return crypto.randomUUID();
}

export type CommsProviderStatus = Omit<
  SetupAuthStatus['providers'][number],
  'id'
> & {
  id: CommsProviderId;
  telegramWebhook?: TelegramWebhookStatus | null;
  telegramBotUsername?: string | null;
  discord?: DiscordCommsStatus | null;
};

export type CommsStatus = Omit<SetupAuthStatus, 'providers'> & {
  providers: CommsProviderStatus[];
  invocationIdentities: InvocationIdentity[];
};

type TelegramWebhookStatus = {
  status: 'connected' | 'mismatch' | 'stale_updates' | 'unregistered' | 'error';
  registeredUrl: string | null;
  expectedUrl: string;
  lastErrorMessage: string | null;
  pendingUpdateCount: number;
  lastErrorAtMs: number | null;
};

type DiscordGatewayPhase =
  | 'starting'
  | 'standby'
  | 'awaiting_configuration'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'error';

export type DiscordGatewayStatus = {
  phase: DiscordGatewayPhase;
  live: boolean;
  ready: boolean;
  leader: boolean;
  configured: boolean;
  connected: boolean;
  forwardingReady: boolean;
  sessionResumed: boolean;
  queueDepth: number;
  botUserId?: string;
  botUsername?: string;
  lastEventAt?: string;
  lastForwardedAt?: string;
  lastError?: string;
  updatedAt: string;
};

export type DiscordCommsStatus = {
  bot: {
    applicationId: string | null;
    applicationName: string | null;
    userId: string | null;
    username: string | null;
    displayName: string | null;
    identitySource: 'live' | 'persistent_cache' | null;
    errorCode: string | null;
  };
  inviteUrl: string | null;
  gateway: DiscordGatewayStatus | null;
  gatewaySession: {
    lastConnectedAt: Date | null;
    lastHeartbeatAckAt: Date | null;
    disconnectedAt: Date | null;
    lastError: string | null;
  } | null;
  messageContentIntent: 'enabled' | 'disabled' | 'unknown';
  commands: {
    status: 'registered' | 'missing' | 'unknown';
    names: string[];
  };
  installations: Array<{
    guildId: string;
    guildName: string | null;
    defaultChannelId: string | null;
    defaultChannelName: string | null;
    defaultChannelType: number | null;
  }>;
};

const DISCORD_GATEWAY_STATUS_KEY = 'discord:gateway:status';
const DISCORD_REQUIRED_COMMANDS = ['help', 'link', 'new'] as const;
const DISCORD_APPLICATION_MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
const DISCORD_API_TIMEOUT_MS = 5_000;

function createDiscordProvider(input: {
  botToken: string;
  applicationId?: string | null;
}) {
  return new DiscordCommunicationProvider({
    botToken: input.botToken,
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    ...(process.env.DISCORD_API_BASE_URL
      ? { apiBaseUrl: process.env.DISCORD_API_BASE_URL }
      : {}),
    timeoutMs: DISCORD_API_TIMEOUT_MS,
  });
}

function buildDiscordInviteUrl(applicationId: string | null): string | null {
  if (!applicationId) return null;
  const query = new URLSearchParams({
    client_id: applicationId,
    permissions: DISCORD_INSTALL_PERMISSIONS,
    scope: 'bot applications.commands',
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
}

function isDiscordGatewayStatus(value: unknown): value is DiscordGatewayStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DiscordGatewayStatus>;
  return (
    typeof candidate.phase === 'string' &&
    typeof candidate.ready === 'boolean' &&
    typeof candidate.connected === 'boolean' &&
    typeof candidate.updatedAt === 'string'
  );
}

async function getDiscordGatewayStatus(): Promise<DiscordGatewayStatus | null> {
  try {
    const raw = await getRedis().get(DISCORD_GATEWAY_STATUS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDiscordGatewayStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function getDiscordApplicationDiagnostics(input: {
  botToken: string;
  applicationId: string;
}): Promise<{
  messageContentIntent: DiscordCommsStatus['messageContentIntent'];
  commands: DiscordCommsStatus['commands'];
}> {
  const baseUrl = (
    process.env.DISCORD_API_BASE_URL ?? 'https://discord.com/api/v10'
  ).replace(/\/$/u, '');
  const headers = { authorization: `Bot ${input.botToken}` };
  try {
    const [applicationResponse, commandsResponse] = await Promise.all([
      fetch(`${baseUrl}/oauth2/applications/@me`, {
        headers,
        signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
      }),
      fetch(`${baseUrl}/applications/${input.applicationId}/commands`, {
        headers,
        signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
      }),
    ]);
    const application = applicationResponse.ok
      ? ((await applicationResponse.json()) as { flags?: number })
      : null;
    const commands = commandsResponse.ok
      ? ((await commandsResponse.json()) as Array<{ name?: string }>)
      : null;
    const names = (commands ?? [])
      .flatMap((command) =>
        typeof command.name === 'string' ? [command.name] : [],
      )
      .sort();
    const hasRequiredCommands = DISCORD_REQUIRED_COMMANDS.every((command) =>
      names.includes(command),
    );
    return {
      messageContentIntent:
        typeof application?.flags === 'number'
          ? (application.flags & DISCORD_APPLICATION_MESSAGE_CONTENT_FLAGS) !==
            0
            ? 'enabled'
            : 'disabled'
          : 'unknown',
      commands: commands
        ? { status: hasRequiredCommands ? 'registered' : 'missing', names }
        : { status: 'unknown', names: [] },
    };
  } catch {
    return {
      messageContentIntent: 'unknown',
      commands: { status: 'unknown', names: [] },
    };
  }
}

async function getDiscordCommsStatus(): Promise<DiscordCommsStatus | null> {
  const credentials = await resolveDiscordRuntimeCredentials();
  if (!credentials.botToken) return null;
  const tokenFingerprint = createHash('sha256')
    .update(credentials.botToken)
    .digest('hex');

  const [gateway, gatewaySession, installations, applicationDiagnostics] =
    await Promise.all([
      getDiscordGatewayStatus(),
      db.query.discordGatewaySessions.findFirst({
        where: like(discordGatewaySessions.id, `${tokenFingerprint}:%`),
        orderBy: [desc(discordGatewaySessions.updatedAt)],
        columns: {
          lastConnectedAt: true,
          lastHeartbeatAckAt: true,
          disconnectedAt: true,
          lastError: true,
        },
      }),
      listDiscordInstallations(),
      credentials.applicationId
        ? getDiscordApplicationDiagnostics({
            botToken: credentials.botToken,
            applicationId: credentials.applicationId,
          })
        : Promise.resolve({
            messageContentIntent: 'unknown' as const,
            commands: { status: 'unknown' as const, names: [] },
          }),
    ]);

  return {
    bot: {
      applicationId: credentials.applicationId,
      applicationName: credentials.applicationName,
      userId: credentials.botUserId,
      username: credentials.botUsername,
      displayName: credentials.botDisplayName,
      identitySource: credentials.identitySource,
      errorCode: credentials.identityErrorCode,
    },
    inviteUrl: buildDiscordInviteUrl(credentials.applicationId),
    gateway,
    gatewaySession: gatewaySession ?? null,
    messageContentIntent: applicationDiagnostics.messageContentIntent,
    commands: applicationDiagnostics.commands,
    installations: installations.map((installation) => ({
      guildId: installation.guildId,
      guildName: installation.guildName,
      defaultChannelId: installation.defaultChannelId,
      defaultChannelName: installation.defaultChannelName,
      defaultChannelType: installation.defaultChannelType,
    })),
  };
}

const TELEGRAM_WEBHOOK_REQUIRED_UPDATES = ['message', 'callback_query'];
const TELEGRAM_BOT_API_TIMEOUT_MS = 5_000;

function buildExpectedTelegramWebhookUrl(): string {
  return new URL('/api/webhooks/telegram', Env.R_APP_URL).toString();
}

function createTelegramBotApiFetch(): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.timeout(TELEGRAM_BOT_API_TIMEOUT_MS),
    });
}

const TELEGRAM_WEBHOOK_ERROR_RECENCY_MS = 60 * 60 * 1000;

/** Map Bot API / network failures into admin-facing webhook check copy. */
export function classifyTelegramWebhookCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const errorName = error instanceof Error ? error.name : '';

  if (
    errorName === 'TimeoutError' ||
    errorName === 'AbortError' ||
    lower.includes('aborted') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return 'Could not reach the Telegram Bot API to check the webhook (timed out).';
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('network') ||
    lower.includes('certificate') ||
    lower.includes('getaddrinfo')
  ) {
    return 'Could not reach the Telegram Bot API to check the webhook.';
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('invalid token') ||
    lower.includes('(401)') ||
    // Malformed tokens often get HTTP 404 Not Found from Telegram.
    lower.includes('(404)') ||
    /(?:^|:\s*)not found\.?$/i.test(message.trim())
  ) {
    return 'Telegram rejected the bot token. Check the token from BotFather and save again.';
  }

  const telegramApiMatch = message.match(
    /^Telegram getWebhookInfo failed(?:\s*\(\d+\))?:\s*(.+)$/i,
  );
  if (telegramApiMatch?.[1]) {
    return `Telegram API error while checking the webhook: ${telegramApiMatch[1]}`;
  }

  if (message.trim().length > 0) {
    return `Could not check the Telegram webhook: ${message}`;
  }

  return 'Could not reach the Telegram Bot API to check the webhook.';
}

async function getTelegramWebhookStatus(): Promise<TelegramWebhookStatus | null> {
  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials({
      fetch: createTelegramBotApiFetch(),
    });

  if (!provider) {
    return null;
  }

  const expectedUrl = buildExpectedTelegramWebhookUrl();

  try {
    const rawInfo = await provider.getWebhookInfo();
    // Telegram keeps last_error_message forever; only surface errors that
    // happened recently so a healed webhook does not look broken.
    const isRecentError =
      rawInfo.lastErrorAtMs !== null &&
      Date.now() - rawInfo.lastErrorAtMs < TELEGRAM_WEBHOOK_ERROR_RECENCY_MS;
    const info = {
      ...rawInfo,
      lastErrorMessage: isRecentError ? rawInfo.lastErrorMessage : null,
    };

    if (!info.url) {
      return {
        status: 'unregistered',
        registeredUrl: null,
        expectedUrl,
        lastErrorMessage: info.lastErrorMessage,
        pendingUpdateCount: info.pendingUpdateCount,
        lastErrorAtMs: info.lastErrorAtMs,
      };
    }

    if (info.url !== expectedUrl) {
      return {
        status: 'mismatch',
        registeredUrl: info.url,
        expectedUrl,
        lastErrorMessage: info.lastErrorMessage,
        pendingUpdateCount: info.pendingUpdateCount,
        lastErrorAtMs: info.lastErrorAtMs,
      };
    }

    const hasRequiredUpdates = TELEGRAM_WEBHOOK_REQUIRED_UPDATES.every(
      (update) => info.allowedUpdates.includes(update),
    );

    return {
      status: hasRequiredUpdates ? 'connected' : 'stale_updates',
      registeredUrl: info.url,
      expectedUrl,
      lastErrorMessage: info.lastErrorMessage,
      pendingUpdateCount: info.pendingUpdateCount,
      lastErrorAtMs: info.lastErrorAtMs,
    };
  } catch (error) {
    return {
      status: 'error',
      registeredUrl: null,
      expectedUrl,
      lastErrorMessage: classifyTelegramWebhookCheckError(error),
      pendingUpdateCount: 0,
      lastErrorAtMs: null,
    };
  }
}

type TelegramWebhookRegistrationResult = {
  registered: boolean;
  error: string | null;
};

async function registerTelegramWebhookBestEffort(): Promise<TelegramWebhookRegistrationResult> {
  invalidateTelegramRuntimeCredentialsCache();

  const { webhookSecret } = await resolveTelegramRuntimeCredentials();
  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials({
      fetch: createTelegramBotApiFetch(),
    });

  if (!provider || !webhookSecret) {
    return {
      registered: false,
      error: 'Telegram bot token or webhook secret is not configured.',
    };
  }

  try {
    await Promise.all([
      provider.registerWebhook({
        url: buildExpectedTelegramWebhookUrl(),
        secretToken: webhookSecret,
      }),
      provider.registerCommands(),
    ]);

    return { registered: true, error: null };
  } catch (error) {
    return {
      registered: false,
      error: classifyTelegramWebhookCheckError(error),
    };
  }
}

export async function repairTelegramWebhookCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const result = await registerTelegramWebhookBestEffort();
  if (!result.registered) {
    throw new Error(result.error ?? 'Could not repair Telegram connection.');
  }
  return { repaired: true };
}

type DiscordRegistrationResult = {
  registered: boolean;
  guildCount: number;
  error: string | null;
};

function classifyDiscordSetupError(error: unknown): string {
  if (error instanceof DiscordBotTokenValidationError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized|invalid token/iu.test(message)) {
    return 'Discord rejected the bot token. Copy a fresh token from the Discord Developer Portal and save again.';
  }
  if (/403|missing permissions/iu.test(message)) {
    return 'Discord rejected the request because Roomote is missing permissions in that server.';
  }
  return message.trim() || 'Could not connect to Discord.';
}

async function requireDiscordProvider() {
  const credentials = await resolveDiscordRuntimeCredentials();
  if (
    !credentials.botToken ||
    !credentials.applicationId ||
    !credentials.botUserId
  ) {
    throw new Error(
      credentials.identityErrorCode
        ? 'Discord could not validate the saved bot token.'
        : 'Discord is not configured. Save a bot token first.',
    );
  }
  return {
    credentials,
    provider: createDiscordProvider({
      botToken: credentials.botToken,
      applicationId: credentials.applicationId,
    }),
  };
}

async function syncDiscordGuilds(installedByUserId: string) {
  const { provider, credentials } = await requireDiscordProvider();
  const guilds = await provider.listGuilds();
  await reconcileDiscordInstallations({
    applicationId: credentials.applicationId!,
    botUserId: credentials.botUserId!,
    installedByUserId,
    guilds: guilds.map((guild) => ({
      guildId: guild.id,
      guildName: guild.name,
    })),
  });
  return guilds;
}

async function registerDiscordCommandsBestEffort(
  installedByUserId: string,
): Promise<DiscordRegistrationResult> {
  invalidateDiscordRuntimeCredentialsCache();
  try {
    const { provider, credentials } = await requireDiscordProvider();
    await provider.registerCommands({
      applicationId: credentials.applicationId!,
    });
    const guilds = await syncDiscordGuilds(installedByUserId);
    return { registered: true, guildCount: guilds.length, error: null };
  } catch (error) {
    return {
      registered: false,
      guildCount: 0,
      error: classifyDiscordSetupError(error),
    };
  }
}

export async function registerDiscordCommandsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const result = await registerDiscordCommandsBestEffort(auth.userId);
  if (!result.registered) {
    throw new Error(result.error ?? 'Could not register Discord commands.');
  }
  return result;
}

export async function repairDiscordCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const result = await registerDiscordCommandsBestEffort(auth.userId);
  if (!result.registered) {
    throw new Error(result.error ?? 'Could not repair the Discord connection.');
  }
  return { repaired: true, guildCount: result.guildCount };
}

export async function listDiscordGuildsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  try {
    const guilds = await syncDiscordGuilds(auth.userId);
    const installations = await listDiscordInstallations();
    const installationByGuildId = new Map(
      installations.map((installation) => [installation.guildId, installation]),
    );
    return {
      guilds: guilds.map((guild) => {
        const installation = installationByGuildId.get(guild.id);
        return {
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          defaultChannelId: installation?.defaultChannelId ?? null,
          defaultChannelName: installation?.defaultChannelName ?? null,
          defaultChannelType: installation?.defaultChannelType ?? null,
        };
      }),
    };
  } catch (error) {
    throw new Error(classifyDiscordSetupError(error));
  }
}

const DISCORD_DESTINATION_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

export async function listDiscordChannelsCommand(
  auth: UserAuthSuccess,
  input: { guildId: string },
) {
  assertAdmin(auth);
  try {
    const { provider } = await requireDiscordProvider();
    const channels = (await provider.listGuildChannels(input.guildId)).filter(
      (channel) => DISCORD_DESTINATION_CHANNEL_TYPES.has(channel.type),
    );
    await syncDiscordInstallationChannels({
      guildId: input.guildId,
      channels: channels.map((channel) => ({
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        parentId: channel.parentId ?? null,
        position: channel.position ?? null,
      })),
    });
    return {
      channels: channels.map((channel) => {
        const requiresTag = discordChannelRequiresTag(channel);
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          kind: channel.type === 15 || channel.type === 16 ? 'forum' : 'text',
          parentId: channel.parentId ?? null,
          position: channel.position ?? null,
          flags: channel.flags ?? 0,
          availableTags: channel.availableTags ?? [],
          requiresTag,
          supported: !requiresTag,
        };
      }),
    };
  } catch (error) {
    throw new Error(classifyDiscordSetupError(error));
  }
}

export async function selectDiscordDestinationCommand(
  auth: UserAuthSuccess,
  input: { guildId: string; channelId: string },
) {
  assertAdmin(auth);
  const { channels } = await listDiscordChannelsCommand(auth, {
    guildId: input.guildId,
  });
  const channel = channels.find(
    (candidate) => candidate.id === input.channelId,
  );
  if (!channel) {
    throw new Error('Choose a text or forum channel visible to the bot.');
  }
  if (!channel.supported) {
    throw new Error(DISCORD_REQUIRED_TAG_FORUM_ERROR);
  }
  const permissions = await diagnoseDiscordPermissionsCommand(auth, input);
  if (!permissions.canUseChannel) {
    throw new Error(
      `Roomote is missing required permissions in #${channel.name}: ${permissions.missingPermissions.join(', ')}.`,
    );
  }
  return captureDiscordDefaultDestination({
    guildId: input.guildId,
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
  });
}

export async function diagnoseDiscordPermissionsCommand(
  auth: UserAuthSuccess,
  input: { guildId: string; channelId: string },
): Promise<DiscordChannelPermissionDiagnostics> {
  assertAdmin(auth);
  try {
    const { provider } = await requireDiscordProvider();
    return await provider.diagnoseChannelPermissions(input);
  } catch (error) {
    throw new Error(classifyDiscordSetupError(error));
  }
}

function withAdditionalCommsProviders(
  status: SetupAuthStatus,
  options: {
    persistedEnvVarNames: string[];
    telegramWebhook: TelegramWebhookStatus | null;
    discord: DiscordCommsStatus | null;
    invocationIdentities: InvocationIdentity[];
  },
): CommsStatus {
  const {
    persistedEnvVarNames,
    telegramWebhook,
    discord,
    invocationIdentities,
  } = options;
  const telegramBotUsername =
    invocationIdentities.find((identity) => identity.provider === 'telegram')
      ?.displayName ?? null;
  const isSaved = (name: string) => persistedEnvVarNames.includes(name);
  const isRuntime = (name: string) => Boolean(process.env[name]?.trim());
  const isSatisfied = (name: string) => isRuntime(name) || isSaved(name);
  const buildProviderStatus = (
    definition: AdditionalCommsProviderDefinition,
  ): CommsProviderStatus => {
    const fields = definition.fields.map((field) => ({
      ...field,
      runtimeSatisfied: isRuntime(field.envVarName),
      savedSatisfied: isSaved(field.envVarName),
      savedValue: null,
      satisfiedByEnvVarName: isSatisfied(field.envVarName)
        ? field.envVarName
        : null,
    }));
    const requiredFields = fields.filter((field) => field.required !== false);
    return {
      id: definition.id,
      label: definition.label,
      fields,
      runtimeSatisfied: requiredFields.every((field) =>
        isRuntime(field.envVarName),
      ),
      savedSatisfied: requiredFields.every((field) =>
        isSaved(field.envVarName),
      ),
      setupSatisfied: requiredFields.every((field) =>
        isSatisfied(field.envVarName),
      ),
      ...(definition.id === 'telegram'
        ? { telegramWebhook, telegramBotUsername }
        : {}),
      ...(definition.id === 'discord' ? { discord } : {}),
    };
  };

  return {
    ...status,
    invocationIdentities,
    providers: [
      ...status.providers,
      buildProviderStatus(ADDITIONAL_COMMS_PROVIDERS.telegram),
      buildProviderStatus(ADDITIONAL_COMMS_PROVIDERS.discord),
    ],
  };
}

export async function getCommsStatusCommand(
  auth: UserAuthSuccess,
): Promise<CommsStatus> {
  assertAdmin(auth);

  const [
    persistedEnvVarNames,
    nonSecretAuthEnvValues,
    telegramWebhook,
    discord,
    invocationIdentities,
  ] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([...NON_SECRET_AUTH_ENV_VAR_NAMES]),
    getTelegramWebhookStatus(),
    getDiscordCommsStatus(),
    resolveInvocationIdentities(),
  ]);

  return withAdditionalCommsProviders(
    buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues: nonSecretAuthEnvValues,
    }),
    {
      persistedEnvVarNames,
      telegramWebhook,
      discord,
      invocationIdentities,
    },
  );
}

export async function saveCommsAuthConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: CommsProviderId;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getCommsProviderDefinition(input.provider);
  const enteredDiscordToken = normalizeDiscordBotToken(
    input.values?.R_DISCORD_BOT_TOKEN,
  );
  if (input.provider === 'discord' && enteredDiscordToken) {
    try {
      await validateDiscordBotToken(enteredDiscordToken);
    } catch (error) {
      if (error instanceof DiscordBotTokenValidationError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  await db.transaction(async (tx) => {
    const persistedEnvVarNames = await getPersistedEnvironmentVariableNames(tx);
    const authSetup = buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      selectedProvider: isAdditionalCommsProviderId(input.provider)
        ? undefined
        : input.provider,
    });
    const providerStatus = isAdditionalCommsProviderId(input.provider)
      ? ({
          ...provider,
          fields: provider.fields.map((field) => ({
            ...field,
            runtimeSatisfied: field.acceptedEnvVarNames.some((envVarName) =>
              Boolean(process.env[envVarName]?.trim()),
            ),
            savedSatisfied: field.acceptedEnvVarNames.some((envVarName) =>
              persistedEnvVarNames.includes(envVarName),
            ),
            satisfiedByEnvVarName:
              field.acceptedEnvVarNames.find((envVarName) =>
                Boolean(process.env[envVarName]?.trim()),
              ) ??
              field.acceptedEnvVarNames.find((envVarName) =>
                persistedEnvVarNames.includes(envVarName),
              ) ??
              null,
          })),
          runtimeSatisfied: provider.fields.every((field) =>
            field.acceptedEnvVarNames.some((envVarName) =>
              Boolean(process.env[envVarName]?.trim()),
            ),
          ),
          savedSatisfied: provider.fields.every((field) =>
            field.acceptedEnvVarNames.some((envVarName) =>
              persistedEnvVarNames.includes(envVarName),
            ),
          ),
          setupSatisfied: provider.fields.every((field) => {
            const runtimeSatisfied = field.acceptedEnvVarNames.some(
              (envVarName) => Boolean(process.env[envVarName]?.trim()),
            );
            const savedSatisfied = field.acceptedEnvVarNames.some(
              (envVarName) => persistedEnvVarNames.includes(envVarName),
            );

            return (
              field.required === false || runtimeSatisfied || savedSatisfied
            );
          }),
        } satisfies CommsProviderStatus)
      : authSetup.providers.find(
          (candidate) => candidate.id === input.provider,
        );

    if (!providerStatus) {
      throw new Error('Selected auth provider is unavailable.');
    }

    const valuesToSave = providerStatus.fields.flatMap((field) => {
      const rawValue = input.values?.[field.envVarName] ?? '';
      const nextValue =
        field.envVarName === 'R_TELEGRAM_BOT_TOKEN'
          ? (normalizeTelegramBotToken(rawValue) ?? '')
          : field.envVarName === 'R_DISCORD_BOT_TOKEN'
            ? (normalizeDiscordBotToken(rawValue) ?? '')
            : rawValue.trim();

      if (!nextValue) {
        return [];
      }

      return [
        {
          name: field.envVarName,
          value: nextValue,
        },
      ];
    });

    if (input.provider === 'telegram') {
      const telegramWebhookSecret =
        input.values?.R_TELEGRAM_WEBHOOK_SECRET?.trim() ??
        (providerStatus.fields.find(
          (field) => field.envVarName === 'R_TELEGRAM_WEBHOOK_SECRET',
        )?.savedSatisfied
          ? undefined
          : createTelegramWebhookSecret());
      if (telegramWebhookSecret) {
        valuesToSave.push({
          name: 'R_TELEGRAM_WEBHOOK_SECRET',
          value: telegramWebhookSecret,
        });
      }
    }

    const hasConfiguredAuthEnvVar = (name: string) =>
      Boolean(process.env[name]?.trim()) ||
      persistedEnvVarNames.includes(name) ||
      Boolean(input.values?.[name]?.trim());

    const microsoftTeamsBotResolution =
      input.provider === 'microsoft'
        ? resolveTeamsBotCredentialEnvVarNames({
            hasConfiguredEnvVar: hasConfiguredAuthEnvVar,
          })
        : null;

    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      if (
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied ||
        nextValue.length > 0
      ) {
        return false;
      }

      // Microsoft single-app setup can satisfy Teams bot fields from Microsoft
      // sign-in values without writing explicit R_TEAMS_BOT_* snapshots.
      if (
        microsoftTeamsBotResolution?.source === 'microsoft_auth' &&
        microsoftTeamsBotResolution.fieldSourceEnvVarNames[
          field.envVarName as keyof typeof microsoftTeamsBotResolution.fieldSourceEnvVarNames
        ]
      ) {
        return false;
      }

      return true;
    });

    if (hasMissingRequiredValue) {
      throw new Error(
        `Enter the required ${provider.label} configuration values to continue.`,
      );
    }

    if (valuesToSave.length > 0) {
      await upsertDeploymentEnvironmentVariables(tx, {
        userId,
        values: valuesToSave,
      });
    }
  });

  if (input.provider === 'slack') {
    invalidateSlackSigningSecretCache();
  }

  if (input.provider === 'microsoft') {
    invalidateTeamsBotRuntimeCredentialsCache();
  }

  if (input.provider === 'discord') {
    invalidateDiscordRuntimeCredentialsCache();
  }

  // Registration talks to the Telegram Bot API, so it runs after the
  // transaction commits; a registration failure must not roll back the
  // saved configuration.
  const telegramWebhook =
    input.provider === 'telegram'
      ? await registerTelegramWebhookBestEffort()
      : null;

  const discord =
    input.provider === 'discord'
      ? await registerDiscordCommandsBestEffort(auth.userId)
      : null;

  return {
    telegramWebhook,
    ...(discord ? { discord } : {}),
  };
}

export async function clearCommsAuthConfigCommand(
  auth: UserAuthSuccess,
  input: { provider: CommsProviderId },
) {
  assertAdmin(auth);

  const provider = getCommsProviderDefinition(input.provider);
  const fieldEnvVarNames = provider.fields.flatMap((field) => [
    ...field.acceptedEnvVarNames,
  ]);
  if (input.provider === 'telegram') {
    // Clean up the retired field for existing installations.
    fieldEnvVarNames.push('R_TELEGRAM_BOT_USERNAME');
  }

  if (fieldEnvVarNames.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await deleteDeploymentEnvVarsByNames(tx, fieldEnvVarNames);
  });

  if (input.provider === 'telegram') {
    invalidateTelegramRuntimeCredentialsCache();
  }

  if (input.provider === 'slack') {
    invalidateSlackSigningSecretCache();
  }

  if (input.provider === 'microsoft') {
    invalidateTeamsBotRuntimeCredentialsCache();
  }

  if (input.provider === 'discord') {
    invalidateDiscordRuntimeCredentialsCache();
  }
}

async function deleteDeploymentEnvVarsByNames(
  tx: DatabaseOrTransaction,
  names: string[],
) {
  await tx
    .delete(environmentVariables)
    .where(
      and(
        isNull(environmentVariables.userId),
        inArray(environmentVariables.name, names),
      ),
    );
}

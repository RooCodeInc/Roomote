import { createHash } from 'node:crypto';

import {
  DiscordBotTokenValidationError,
  discordGatewaySessions,
  invalidateAgentMailRuntimeCredentialsCache,
  invalidateDiscordRuntimeCredentialsCache,
  normalizeDiscordBotToken,
  resolveAgentMailRuntimeCredentials,
  resolveDiscordGatewaySecret,
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
  AgentMailApiClient,
  AgentMailApiError,
  type AgentMailWebhook,
} from '@roomote/communication/agentmail-provider';
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

import {
  Env,
  isEmailChannelEnabled,
  isRoomoteCloudEnabled,
} from '@/lib/server/env';
import { DISCORD_INSTALL_PERMISSIONS } from '@/lib/discord-install';
import {
  PRODUCT_NAME,
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
import {
  assertTeamsBotCredentialsAuthenticate,
  invalidateTeamsBotCredentialCheckCache,
} from '../teams/bot-credential-check';

type AdditionalCommsProviderId = 'telegram' | 'discord' | 'agentmail';
type CommsProviderId = SetupAuthProviderId | AdditionalCommsProviderId;
export const COMMS_PROVIDER_IDS = [
  ...SETUP_AUTH_PROVIDER_IDS,
  'telegram',
  'discord',
  'agentmail',
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
  agentmail: {
    id: 'agentmail',
    label: 'Email (AgentMail)',
    fields: [
      {
        envVarName: 'R_AGENTMAIL_API_KEY',
        acceptedEnvVarNames: ['R_AGENTMAIL_API_KEY'],
        label: 'AgentMail API Key',
        secret: true,
      },
    ],
  },
};

function isAdditionalCommsProviderId(
  provider: CommsProviderId,
): provider is AdditionalCommsProviderId {
  return (
    provider === 'telegram' ||
    provider === 'discord' ||
    provider === 'agentmail'
  );
}

function getCommsProviderDefinition(provider: CommsProviderId) {
  return isAdditionalCommsProviderId(provider)
    ? ADDITIONAL_COMMS_PROVIDERS[provider]
    : getSetupAuthProvider(provider);
}

function createTelegramWebhookSecret() {
  return crypto.randomUUID();
}

function createDiscordGatewaySecret() {
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
  agentmail?: AgentMailCommsStatus | null;
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

type AgentMailWebhookStatus = {
  status: 'connected' | 'mismatch' | 'unregistered' | 'error';
  registeredUrl: string | null;
  expectedUrl: string;
  errorMessage: string | null;
};

export type AgentMailCommsStatus = {
  /** The routed inbox_id (derived from the key on save and persisted). */
  inboxAddress: string | null;
  /** The deliverable address for display, resolved live from AgentMail. */
  inboxEmail: string | null;
  webhook: AgentMailWebhookStatus;
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
  deadLetterDepth?: number;
  capacityWarning?: string;
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
const DISCORD_REQUIRED_COMMANDS = ['goal', 'help', 'link', 'new'] as const;
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
  const credentials = await resolveTelegramRuntimeCredentials();
  if (credentials.botToken && !credentials.webhookSecret) {
    await db.transaction((tx) =>
      upsertDeploymentEnvironmentVariables(tx, {
        userId: auth.userId,
        values: [
          {
            name: 'R_TELEGRAM_WEBHOOK_SECRET',
            value: createTelegramWebhookSecret(),
          },
        ],
      }),
    );
  }
  const result = await registerTelegramWebhookBestEffort();
  if (!result.registered) {
    throw new Error(result.error ?? 'Could not repair Telegram connection.');
  }
  return { repaired: true };
}

const AGENTMAIL_API_TIMEOUT_MS = 5_000;
/**
 * Client id used before webhook ids became deployment-specific. Still matched
 * on lookup so existing registrations are adopted and converged instead of
 * orphaned.
 */
const AGENTMAIL_LEGACY_WEBHOOK_CLIENT_ID = 'roomote-agentmail-webhook';
const AGENTMAIL_HOST_HASH_LENGTH = 6;

function buildExpectedAgentMailWebhookUrl(): string {
  return new URL('/api/webhooks/agentmail', Env.R_APP_URL).toString();
}

/**
 * Every AgentMail call the deployment makes is addressed to its one inbox:
 * message reads and sends by design, and webhook management through the
 * inbox's own endpoints, which is all an inbox-scoped key can reach (an
 * organization-level key can reach them too).
 */
function createAgentMailApiClient(apiKey: string, inboxId: string | null) {
  return new AgentMailApiClient({
    apiKey,
    ...(inboxId ? { webhookInboxId: inboxId } : {}),
    timeoutMs: AGENTMAIL_API_TIMEOUT_MS,
  });
}

const EMAIL_CHANNEL_DISABLED_MESSAGE =
  'Email is not enabled for this deployment. Set R_EMAIL_CHANNEL_ENABLED=true and restart to configure it.';

function assertEmailChannelEnabled(): void {
  if (!isEmailChannelEnabled()) {
    throw new Error(EMAIL_CHANNEL_DISABLED_MESSAGE);
  }
}

function assertAgentMailMutationAllowed(provider: CommsProviderId): void {
  if (provider === 'agentmail' && isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)) {
    throw new Error('Email configuration is managed by Roomote Cloud.');
  }
}

/**
 * Pull "METHOD /path" plus AgentMail's response detail out of the client's
 * error message (`AgentMail GET /v0/webhooks failed (403): {...}`), trimmed
 * so a long body cannot swamp the settings toast.
 */
function describeAgentMailRequest(message: string): string | null {
  const match =
    /^AgentMail (GET|POST|PATCH|DELETE) (\S+) failed \(\d+\)(?::\s*([\s\S]*))?$/u.exec(
      message.trim(),
    );
  if (!match) {
    return null;
  }
  const [, method, path, body] = match;
  const detail = body?.trim().replace(/\s+/gu, ' ') ?? '';
  const clipped = detail.length > 160 ? `${detail.slice(0, 157)}...` : detail;
  return clipped ? `${method} ${path} (${clipped})` : `${method} ${path}`;
}

/**
 * AgentMail keys carry fine-grained permissions
 * (https://docs.agentmail.to/core-concepts/permissions); this is the full set
 * the channel needs across setup, inbound processing, and replies. An
 * inbox-scoped key with these permissions is the intended shape.
 */
const AGENTMAIL_REQUIRED_PERMISSIONS =
  'inbox_read, inbox_update, webhook_read, webhook_create, webhook_update, webhook_delete, message_read, message_send';

const AGENTMAIL_KEY_GUIDANCE =
  'In the AgentMail console, open the inbox Roomote should use and create an API key from inside it (an inbox-scoped key) with these permissions or full access';

/** Map AgentMail API / network failures into admin-facing setup copy. */
function classifyAgentMailSetupError(
  error: unknown,
  operation:
    | 'validating the API key'
    | 'reading inbox messages'
    | 'configuring the webhook' = 'validating the API key',
): string {
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
    return 'Could not reach the AgentMail API (timed out). Check connectivity and save again.';
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
    return 'Could not reach the AgentMail API. Check connectivity and save again.';
  }

  if (
    lower.includes('(401)') ||
    lower.includes('(403)') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('invalid api key')
  ) {
    // Name the exact request AgentMail refused; "check your permissions"
    // alone sends the operator in circles.
    const request = describeAgentMailRequest(message);
    const requestDetail = request ? ` Request: ${request}.` : '';
    if (operation === 'validating the API key') {
      return `AgentMail rejected this API key. ${AGENTMAIL_KEY_GUIDANCE}, then save again: ${AGENTMAIL_REQUIRED_PERMISSIONS}.${requestDetail}`;
    }
    return `AgentMail refused permission while ${operation} (${message.includes('(403)') ? '403 Forbidden' : '401 Unauthorized'}).${requestDetail} ${AGENTMAIL_KEY_GUIDANCE}, then save again: ${AGENTMAIL_REQUIRED_PERMISSIONS}.`;
  }

  return `AgentMail failed while ${operation}: ${message.trim() || 'could not connect.'}`;
}

/**
 * Short stable hash of the deployment's public hostname, keying the webhook
 * client id so two deployments sharing one inbox or account never adopt (or
 * delete) each other's registration.
 */
function buildAgentMailHostHash(publicAppUrl: string): string {
  return createHash('sha256')
    .update(new URL(publicAppUrl).hostname)
    .digest('hex')
    .slice(0, AGENTMAIL_HOST_HASH_LENGTH);
}

function buildAgentMailWebhookClientId(publicAppUrl: string): string {
  return `${AGENTMAIL_LEGACY_WEBHOOK_CLIENT_ID}-${buildAgentMailHostHash(publicAppUrl)}`;
}

function readAgentMailWebhookInboxIds(webhook: AgentMailWebhook): string[] {
  return Array.isArray(webhook.inbox_ids) ? webhook.inbox_ids.map(String) : [];
}

function readAgentMailWebhookEventTypes(webhook: AgentMailWebhook): string[] {
  return Array.isArray(webhook.event_types)
    ? webhook.event_types.map(String)
    : [];
}

function findRoomoteAgentMailWebhook(
  webhooks: readonly AgentMailWebhook[] | undefined,
): AgentMailWebhook | null {
  const deploymentClientId = buildAgentMailWebhookClientId(Env.R_APP_URL);
  return (
    webhooks?.find((webhook) => webhook['client_id'] === deploymentClientId) ??
    webhooks?.find(
      (webhook) => webhook['client_id'] === AGENTMAIL_LEGACY_WEBHOOK_CLIENT_ID,
    ) ??
    null
  );
}

function normalizeAgentMailInboxAddress(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

/**
 * The value setup persists and every later call routes by. AgentMail's
 * schema carries both `inbox_id` and `email` (equal today), but `inbox_id`
 * is the key the API contract requires in request paths and webhook
 * `inbox_ids` filters — so it must win if the fields ever diverge. `email`
 * is only a display fallback for a hypothetical object without an id.
 */
function readAgentMailInboxAddress(
  inbox: Record<string, unknown>,
): string | null {
  const inboxId = typeof inbox.inbox_id === 'string' ? inbox.inbox_id : null;
  const email = typeof inbox.email === 'string' ? inbox.email : null;
  return normalizeAgentMailInboxAddress(inboxId ?? email);
}

/**
 * The deliverable address of an inbox object, for operator-facing display
 * only — never persisted and never used to route (see
 * readAgentMailInboxAddress). Deriving it live from the API each time means
 * a stored value can never drift from AgentMail's record.
 */
function readAgentMailInboxEmail(
  inbox: Record<string, unknown>,
): string | null {
  const email = typeof inbox.email === 'string' ? inbox.email : null;
  return (
    normalizeAgentMailInboxAddress(email) ?? readAgentMailInboxAddress(inbox)
  );
}

/** `email (inbox_id)` when the fields differ, else just the address. */
function formatAgentMailInboxLabel(
  inboxId: string,
  email: string | null,
): string {
  return email && email !== inboxId ? `${email} (${inboxId})` : inboxId;
}

async function getAgentMailCommsStatus(): Promise<AgentMailCommsStatus | null> {
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey) return null;

  const expectedUrl = buildExpectedAgentMailWebhookUrl();
  const client = createAgentMailApiClient(
    credentials.apiKey,
    credentials.inboxId,
  );

  try {
    // Display only: the deliverable address may differ from the routed
    // inbox_id, and resolving it live means it can never drift. Best-effort;
    // the webhook status below is the load-bearing part.
    let inboxEmail: string | null = null;
    if (credentials.inboxId) {
      try {
        const inbox = await client.getInbox(credentials.inboxId);
        inboxEmail = inbox ? readAgentMailInboxEmail(inbox) : null;
      } catch {
        inboxEmail = null;
      }
    }

    const { webhooks } = await client.listWebhooks();
    const webhook = findRoomoteAgentMailWebhook(webhooks);
    const registeredUrl = webhook?.url ?? null;
    // A webhook without inbox_ids receives every inbox's events, so only an
    // explicit scope that omits the configured inbox counts as drift.
    const registeredInboxIds = webhook
      ? readAgentMailWebhookInboxIds(webhook)
      : [];
    const inboxScopeMatches =
      !credentials.inboxId ||
      registeredInboxIds.length === 0 ||
      registeredInboxIds.includes(credentials.inboxId);

    return {
      inboxAddress: credentials.inboxId,
      inboxEmail,
      webhook: {
        status: !webhook
          ? 'unregistered'
          : registeredUrl === expectedUrl && inboxScopeMatches
            ? 'connected'
            : 'mismatch',
        registeredUrl,
        expectedUrl,
        errorMessage: null,
      },
    };
  } catch (error) {
    return {
      inboxAddress: credentials.inboxId,
      inboxEmail: null,
      webhook: {
        status: 'error',
        registeredUrl: null,
        expectedUrl,
        errorMessage: classifyAgentMailSetupError(error),
      },
    };
  }
}

type AgentMailReconcileResult = {
  /** The routed inbox_id — persisted and used in API paths/webhook scoping. */
  inboxAddress: string;
  /** The deliverable address, display only. */
  inboxEmail: string;
  webhookUrl: string;
  webhookSecret: string | null;
};

/**
 * Reconcile AgentMail against this deployment before persisting anything:
 * validate the API key, resolve the one inbox it is for, and converge the
 * webhook registration on this deployment's URL. The inbox is derived from
 * the key, never entered: the intended key is inbox-scoped (it sees exactly
 * its inbox), and an organization-level key is accepted only while the
 * account has exactly one inbox, so there is never a wrong inbox to pick.
 * Every step is idempotent (the webhook is keyed by client id), so a
 * partial failure is fixed by saving again. Failures throw with
 * admin-facing copy and abort the save so credentials are never persisted
 * half-configured.
 */
async function reconcileAgentMailSetup(input: {
  enteredApiKey: string | null;
}): Promise<AgentMailReconcileResult> {
  assertEmailChannelEnabled();
  invalidateAgentMailRuntimeCredentialsCache();
  const existing = await resolveAgentMailRuntimeCredentials();
  const apiKey = input.enteredApiKey ?? existing.apiKey;

  if (!apiKey) {
    throw new Error(
      'Enter the required Email (AgentMail) configuration values to continue.',
    );
  }

  // Prove the key authenticates with the cheapest read, which also tells us
  // which inbox the key is for.
  const visibleInboxes: string[] = [];
  const inboxDisplayNames = new Map<string, string | null>();
  const inboxEmails = new Map<string, string>();
  try {
    const listed = await createAgentMailApiClient(apiKey, null).listInboxes();
    for (const inbox of listed.inboxes ?? []) {
      const address = readAgentMailInboxAddress(inbox);
      if (!address) continue;
      visibleInboxes.push(address);
      inboxDisplayNames.set(
        address,
        typeof inbox.display_name === 'string' ? inbox.display_name : null,
      );
      const email = readAgentMailInboxEmail(inbox);
      if (email) {
        inboxEmails.set(address, email);
      }
    }
  } catch (error) {
    throw new Error(
      classifyAgentMailSetupError(error, 'validating the API key'),
    );
  }

  // An env-var-pinned inbox wins, provided the key can actually see it.
  const pinnedInboxId = process.env.R_AGENTMAIL_INBOX_ID?.trim()
    ? existing.inboxId
    : null;
  if (pinnedInboxId && !visibleInboxes.includes(pinnedInboxId)) {
    throw new Error(
      `R_AGENTMAIL_INBOX_ID is set to ${pinnedInboxId}, but this API key cannot see that inbox. ${AGENTMAIL_KEY_GUIDANCE}, then save again: ${AGENTMAIL_REQUIRED_PERMISSIONS}.`,
    );
  }
  if (visibleInboxes.length === 0) {
    throw new Error(
      `This API key cannot see any inbox. ${AGENTMAIL_KEY_GUIDANCE}, then save again: ${AGENTMAIL_REQUIRED_PERMISSIONS}.`,
    );
  }
  if (!pinnedInboxId && visibleInboxes.length > 1) {
    throw new Error(
      `This API key can see ${visibleInboxes.length} inboxes (${visibleInboxes
        .map((address) =>
          formatAgentMailInboxLabel(address, inboxEmails.get(address) ?? null),
        )
        .join(
          ', ',
        )}), so Roomote cannot tell which one is for this deployment. ${AGENTMAIL_KEY_GUIDANCE}, then save again: ${AGENTMAIL_REQUIRED_PERMISSIONS}.`,
    );
  }
  const inboxAddress = pinnedInboxId ?? visibleInboxes[0]!;
  const client = createAgentMailApiClient(apiKey, inboxAddress);

  // Prove message_read without side effects: fetching a sentinel message id
  // returns 404 when the permission exists and 403 when it does not. An
  // already-converged webhook would otherwise let a key without message
  // permissions reach the successful save path, deferring the failure to
  // runtime (oversize-body re-fetches and every reply). message_send has no
  // side-effect-free probe; it is exercised on the first reply.
  try {
    await client.getMessage(inboxAddress, 'roomote-permission-probe');
  } catch (error) {
    // Only the expected 404 proves the permission; anything else — 403, but
    // also timeouts and network failures — means validation never completed
    // and must fail the save rather than persist an unvalidated key.
    if (!(error instanceof AgentMailApiError) || error.status !== 404) {
      throw new Error(
        classifyAgentMailSetupError(error, 'reading inbox messages'),
      );
    }
  }

  // Recipients see the inbox display name as the sender ("Roomote
  // <address>"); AgentMail's own default reads as "AgentMail". Converging is
  // cosmetic, so a failure logs instead of aborting the save.
  if (inboxDisplayNames.get(inboxAddress) !== PRODUCT_NAME) {
    try {
      await client.updateInbox(inboxAddress, { displayName: PRODUCT_NAME });
    } catch (error) {
      console.warn(
        `[comms] Failed to set the AgentMail inbox display name: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Converge the deployment's webhook (found by client id) on the current
  // URL and event types. The registration is pinned to the inbox by the
  // endpoint it is created through. The webhook secret only exists where
  // AgentMail returns it, so a registration we can no longer verify
  // deliveries for is recreated.
  const webhookUrl = buildExpectedAgentMailWebhookUrl();
  // Bounce/complaint events feed the outbound suppression list; a webhook
  // created by an earlier release only carries message.received, so event
  // types are converged like the URL.
  const desiredEventTypes = [
    'message.received',
    'message.bounced',
    'message.complained',
  ];
  let webhookSecret = existing.webhookSecret;

  try {
    const { webhooks } = await client.listWebhooks();
    const existingWebhook = findRoomoteAgentMailWebhook(webhooks);
    const createDeploymentWebhook = async (): Promise<string | null> => {
      const created = await client.createWebhook({
        url: webhookUrl,
        clientId: buildAgentMailWebhookClientId(Env.R_APP_URL),
        eventTypes: desiredEventTypes,
      });
      return typeof created.secret === 'string' && created.secret.trim()
        ? created.secret.trim()
        : null;
    };

    if (existingWebhook) {
      const registeredEventTypes =
        readAgentMailWebhookEventTypes(existingWebhook);
      const eventTypesMatch =
        registeredEventTypes.length === desiredEventTypes.length &&
        desiredEventTypes.every((type) => registeredEventTypes.includes(type));
      const apiSecret =
        typeof existingWebhook.secret === 'string' &&
        existingWebhook.secret.trim()
          ? existingWebhook.secret.trim()
          : null;
      if (apiSecret) {
        webhookSecret = apiSecret;
      }
      // The URL is immutable on AgentMail's update, and a registration whose
      // secret we cannot verify deliveries for is useless: both cases mean a
      // fresh registration. Event-type drift converges in place.
      if (existingWebhook.url !== webhookUrl || !webhookSecret) {
        await client.deleteWebhook(existingWebhook.webhook_id);
        webhookSecret = await createDeploymentWebhook();
      } else if (!eventTypesMatch) {
        await client.updateWebhook(existingWebhook.webhook_id, {
          eventTypes: desiredEventTypes,
        });
      }
    } else {
      webhookSecret = (await createDeploymentWebhook()) ?? webhookSecret;
    }
  } catch (error) {
    throw new Error(
      classifyAgentMailSetupError(error, 'configuring the webhook'),
    );
  }

  return {
    inboxAddress,
    inboxEmail: inboxEmails.get(inboxAddress) ?? inboxAddress,
    webhookUrl,
    webhookSecret,
  };
}

/** Deleting the webhook must never block a disconnect. */
async function deleteAgentMailWebhookBestEffort(): Promise<void> {
  try {
    const credentials = await resolveAgentMailRuntimeCredentials();
    if (!credentials.apiKey) return;
    const client = createAgentMailApiClient(
      credentials.apiKey,
      credentials.inboxId,
    );
    const { webhooks } = await client.listWebhooks();
    const webhook = findRoomoteAgentMailWebhook(webhooks);
    if (webhook) {
      await client.deleteWebhook(webhook.webhook_id);
    }
  } catch {
    // Best effort only.
  }
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
    // Heal upgrades that configured Discord before R_DISCORD_GATEWAY_SECRET
    // existed so Repair/register can re-enable event forwarding without a
    // full re-save of the bot token.
    const gatewaySecret = await resolveDiscordGatewaySecret();
    if (!gatewaySecret) {
      return {
        registered: false,
        guildCount: 0,
        error:
          'Could not create or load R_DISCORD_GATEWAY_SECRET for Discord event delivery.',
      };
    }
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
        const requiredTagUnavailable =
          requiresTag && (channel.availableTags?.length ?? 0) === 0;
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
          supported: !requiredTagUnavailable,
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
    const missing = permissions.missingPermissions
      .map((name) =>
        name
          .split('_')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' '),
      )
      .join(', ');
    throw new Error(
      `Roomote is missing required permissions in #${channel.name}: ${missing}.`,
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
    persistedEnvVarValues: Record<string, string>;
    telegramWebhook: TelegramWebhookStatus | null;
    discord: DiscordCommsStatus | null;
    agentmail: AgentMailCommsStatus | null;
    invocationIdentities: InvocationIdentity[];
  },
): CommsStatus {
  const {
    persistedEnvVarNames,
    persistedEnvVarValues,
    telegramWebhook,
    discord,
    agentmail,
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
      savedValue:
        field.secret === true
          ? null
          : (persistedEnvVarValues[field.envVarName]?.trim() ?? null),
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
      ...(definition.id === 'agentmail' ? { agentmail } : {}),
    };
  };

  return {
    ...status,
    invocationIdentities,
    providers: [
      ...status.providers,
      buildProviderStatus(ADDITIONAL_COMMS_PROVIDERS.telegram),
      buildProviderStatus(ADDITIONAL_COMMS_PROVIDERS.discord),
      // Email is gated by R_EMAIL_CHANNEL_ENABLED (see isEmailChannelEnabled)
      // and stays out of the settings surface entirely until it is set.
      ...(isEmailChannelEnabled()
        ? [buildProviderStatus(ADDITIONAL_COMMS_PROVIDERS.agentmail)]
        : []),
    ],
  };
}

export async function getCommsStatusCommand(
  auth: UserAuthSuccess,
): Promise<CommsStatus> {
  assertAdmin(auth);

  const [
    persistedEnvVarNames,
    nonSecretEnvValues,
    telegramWebhook,
    discord,
    agentmail,
    invocationIdentities,
  ] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([...NON_SECRET_AUTH_ENV_VAR_NAMES]),
    getTelegramWebhookStatus(),
    getDiscordCommsStatus(),
    getAgentMailCommsStatus(),
    resolveInvocationIdentities(),
  ]);

  return withAdditionalCommsProviders(
    buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues: nonSecretEnvValues,
    }),
    {
      persistedEnvVarNames,
      persistedEnvVarValues: nonSecretEnvValues,
      telegramWebhook,
      discord,
      agentmail,
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
  assertAgentMailMutationAllowed(input.provider);

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

  // Prove the Teams bot credentials authenticate before storing them; a wrong
  // app id or secret otherwise only surfaces as unexplained 401s on the
  // messaging endpoint, long after setup reported success.
  if (input.provider === 'microsoft') {
    await assertTeamsBotCredentialsAuthenticate(input.values);
  }

  // AgentMail saves are a reconcile: validate the key, adopt or provision the
  // inbox, and converge the webhook before anything is persisted, so the
  // stored configuration always includes the final inbox address and the
  // webhook secret AgentMail issued.
  const agentmailSetup =
    input.provider === 'agentmail'
      ? await reconcileAgentMailSetup({
          enteredApiKey: input.values?.R_AGENTMAIL_API_KEY?.trim() || null,
        })
      : null;

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

    if (input.provider === 'discord') {
      const hasDiscordGatewaySecret =
        Boolean(process.env.R_DISCORD_GATEWAY_SECRET?.trim()) ||
        persistedEnvVarNames.includes('R_DISCORD_GATEWAY_SECRET') ||
        Boolean(input.values?.R_DISCORD_GATEWAY_SECRET?.trim());
      const discordGatewaySecret =
        input.values?.R_DISCORD_GATEWAY_SECRET?.trim() ??
        (hasDiscordGatewaySecret ? undefined : createDiscordGatewaySecret());
      if (discordGatewaySecret) {
        valuesToSave.push({
          name: 'R_DISCORD_GATEWAY_SECRET',
          value: discordGatewaySecret,
        });
      }
    }

    if (input.provider === 'agentmail' && agentmailSetup) {
      // The inbox is derived from the key, never entered: persist the
      // reconciled address (so runtime callers route without re-listing)
      // plus the webhook secret AgentMail issued for delivery verification.
      valuesToSave.push({
        name: 'R_AGENTMAIL_INBOX_ID',
        value: agentmailSetup.inboxAddress,
      });
      if (agentmailSetup.webhookSecret) {
        valuesToSave.push({
          name: 'R_AGENTMAIL_WEBHOOK_SECRET',
          value: agentmailSetup.webhookSecret,
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
    invalidateTeamsBotCredentialCheckCache();
  }

  if (input.provider === 'discord') {
    invalidateDiscordRuntimeCredentialsCache();
  }

  if (input.provider === 'agentmail') {
    invalidateAgentMailRuntimeCredentialsCache();
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
    ...(agentmailSetup
      ? {
          agentmail: {
            inboxAddress: agentmailSetup.inboxAddress,
            inboxEmail: agentmailSetup.inboxEmail,
            webhookUrl: agentmailSetup.webhookUrl,
          },
        }
      : {}),
  };
}

export async function clearCommsAuthConfigCommand(
  auth: UserAuthSuccess,
  input: { provider: CommsProviderId },
) {
  assertAdmin(auth);
  assertAgentMailMutationAllowed(input.provider);

  const provider = getCommsProviderDefinition(input.provider);
  const fieldEnvVarNames = provider.fields.flatMap((field) => [
    ...field.acceptedEnvVarNames,
  ]);
  if (input.provider === 'telegram') {
    // Clean up the retired field for existing installations.
    fieldEnvVarNames.push('R_TELEGRAM_BOT_USERNAME');
  }

  if (input.provider === 'agentmail') {
    // The webhook secret is provisioned server-side rather than entered, so
    // it is not a field; remove it with the credentials, and best-effort
    // unregister the webhook while the API key is still available.
    // The inbox and webhook secret are derived on save rather than entered,
    // so they are not fields; remove them with the key, and best-effort
    // unregister the webhook while the key is still available. The pod id
    // is a retired field from an earlier build.
    fieldEnvVarNames.push(
      'R_AGENTMAIL_INBOX_ID',
      'R_AGENTMAIL_WEBHOOK_SECRET',
      'R_AGENTMAIL_POD_ID',
    );
    await deleteAgentMailWebhookBestEffort();
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
    invalidateTeamsBotCredentialCheckCache();
  }

  if (input.provider === 'discord') {
    invalidateDiscordRuntimeCredentialsCache();
  }

  if (input.provider === 'agentmail') {
    invalidateAgentMailRuntimeCredentialsCache();
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

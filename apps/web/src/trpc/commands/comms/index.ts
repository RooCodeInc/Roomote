import {
  resolveTelegramRuntimeCredentials,
  invalidateTelegramRuntimeCredentialsCache,
  invalidateTeamsBotRuntimeCredentialsCache,
  invalidateSlackSigningSecretCache,
  resolveInvocationIdentities,
  normalizeTelegramBotToken,
  db,
  environmentVariables,
  and,
  inArray,
  isNull,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';

import { Env } from '@/lib/server/env';
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

type CommsProviderId = SetupAuthProviderId | 'telegram';
export const COMMS_PROVIDER_IDS = [
  ...SETUP_AUTH_PROVIDER_IDS,
  'telegram',
] as const;

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
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  const expectedUrl = buildExpectedTelegramWebhookUrl();
  const provider = new TelegramCommunicationProvider({
    botToken,
    fetch: createTelegramBotApiFetch(),
  });

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

  const { botToken, webhookSecret } = await resolveTelegramRuntimeCredentials();

  if (!botToken || !webhookSecret) {
    return {
      registered: false,
      error: 'Telegram bot token or webhook secret is not configured.',
    };
  }

  const provider = new TelegramCommunicationProvider({
    botToken,
    fetch: createTelegramBotApiFetch(),
  });

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

function withTelegramProvider(
  status: SetupAuthStatus,
  options: {
    persistedEnvVarNames: string[];
    telegramWebhook: TelegramWebhookStatus | null;
    invocationIdentities: InvocationIdentity[];
  },
): CommsStatus {
  const { persistedEnvVarNames, telegramWebhook, invocationIdentities } =
    options;
  const telegramBotUsername =
    invocationIdentities.find((identity) => identity.provider === 'telegram')
      ?.displayName ?? null;
  const isSaved = (name: string) => persistedEnvVarNames.includes(name);
  const isRuntime = (name: string) => Boolean(process.env[name]?.trim());
  const isSatisfied = (name: string) => isRuntime(name) || isSaved(name);
  const buildField = (input: {
    envVarName: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    savedValue?: string | null;
  }) => ({
    envVarName: input.envVarName,
    acceptedEnvVarNames: [input.envVarName],
    label: input.label,
    ...(input.secret ? { secret: true } : {}),
    ...(input.required === false ? { required: false as const } : {}),
    runtimeSatisfied: isRuntime(input.envVarName),
    savedSatisfied: isSaved(input.envVarName),
    savedValue: input.secret ? null : (input.savedValue ?? null),
    satisfiedByEnvVarName: isSatisfied(input.envVarName)
      ? input.envVarName
      : null,
  });

  return {
    ...status,
    invocationIdentities,
    providers: [
      ...status.providers,
      {
        id: 'telegram',
        label: 'Telegram',
        fields: [
          buildField({
            envVarName: 'R_TELEGRAM_BOT_TOKEN',
            label: 'Telegram Bot Token',
            secret: true,
          }),
          buildField({
            envVarName: 'R_TELEGRAM_WEBHOOK_SECRET',
            label: 'Telegram Webhook Secret',
            secret: true,
            required: false,
          }),
        ],
        runtimeSatisfied: isRuntime('R_TELEGRAM_BOT_TOKEN'),
        savedSatisfied: isSaved('R_TELEGRAM_BOT_TOKEN'),
        setupSatisfied: isSatisfied('R_TELEGRAM_BOT_TOKEN'),
        telegramWebhook,
        telegramBotUsername,
      },
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
    invocationIdentities,
  ] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([...NON_SECRET_AUTH_ENV_VAR_NAMES]),
    getTelegramWebhookStatus(),
    resolveInvocationIdentities(),
  ]);

  return withTelegramProvider(
    buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues: nonSecretAuthEnvValues,
    }),
    {
      persistedEnvVarNames,
      telegramWebhook,
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
  const provider =
    input.provider === 'telegram'
      ? {
          id: 'telegram' as const,
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
        }
      : getSetupAuthProvider(input.provider);

  await db.transaction(async (tx) => {
    const persistedEnvVarNames = await getPersistedEnvironmentVariableNames(tx);
    const authSetup = buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      selectedProvider:
        input.provider === 'telegram' ? undefined : input.provider,
    });
    const providerStatus =
      input.provider === 'telegram'
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

  // Registration talks to the Telegram Bot API, so it runs after the
  // transaction commits; a registration failure must not roll back the
  // saved configuration.
  const telegramWebhook =
    input.provider === 'telegram'
      ? await registerTelegramWebhookBestEffort()
      : null;

  return { telegramWebhook };
}

export async function clearCommsAuthConfigCommand(
  auth: UserAuthSuccess,
  input: { provider: CommsProviderId },
) {
  assertAdmin(auth);

  const provider =
    input.provider === 'telegram'
      ? {
          fields: [
            { acceptedEnvVarNames: ['R_TELEGRAM_BOT_TOKEN'] },
            { acceptedEnvVarNames: ['R_TELEGRAM_WEBHOOK_SECRET'] },
            // Clean up the retired field for existing installations.
            { acceptedEnvVarNames: ['R_TELEGRAM_BOT_USERNAME'] },
          ],
        }
      : getSetupAuthProvider(input.provider);
  const fieldEnvVarNames = provider.fields.flatMap((field) => [
    ...field.acceptedEnvVarNames,
  ]);

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

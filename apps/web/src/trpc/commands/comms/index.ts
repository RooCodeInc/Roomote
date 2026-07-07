import {
  resolveTelegramRuntimeCredentials,
  invalidateTelegramRuntimeCredentialsCache,
  invalidateTeamsBotRuntimeCredentialsCache,
  invalidateSlackSigningSecretCache,
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
  SETUP_AUTH_PROVIDER_IDS,
  type SetupAuthProviderId,
  type SetupAuthStatus,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import {
  assertAdmin,
  getPersistedEnvironmentVariableNames,
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
};

export type CommsStatus = Omit<SetupAuthStatus, 'providers'> & {
  providers: CommsProviderStatus[];
};

type TelegramWebhookStatus = {
  status: 'connected' | 'mismatch' | 'stale_updates' | 'unregistered' | 'error';
  registeredUrl: string | null;
  expectedUrl: string;
  lastErrorMessage: string | null;
};

const TELEGRAM_WEBHOOK_REQUIRED_UPDATES = ['message', 'callback_query'];
const TELEGRAM_BOT_API_TIMEOUT_MS = 5_000;

function buildExpectedTelegramWebhookUrl(): string {
  return new URL('/api/webhooks/telegram', Env.ROOMOTE_APP_URL).toString();
}

function createTelegramBotApiFetch(): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.timeout(TELEGRAM_BOT_API_TIMEOUT_MS),
    });
}

const TELEGRAM_WEBHOOK_ERROR_RECENCY_MS = 60 * 60 * 1000;

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
      };
    }

    if (info.url !== expectedUrl) {
      return {
        status: 'mismatch',
        registeredUrl: info.url,
        expectedUrl,
        lastErrorMessage: info.lastErrorMessage,
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
    };
  } catch {
    return {
      status: 'error',
      registeredUrl: null,
      expectedUrl,
      lastErrorMessage: null,
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
    await provider.registerWebhook({
      url: buildExpectedTelegramWebhookUrl(),
      secretToken: webhookSecret,
    });

    return { registered: true, error: null };
  } catch (error) {
    return {
      registered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function withTelegramProvider(
  status: SetupAuthStatus,
  options: {
    persistedEnvVarNames: string[];
    telegramWebhook: TelegramWebhookStatus | null;
  },
): CommsStatus {
  const { persistedEnvVarNames, telegramWebhook } = options;
  const isSaved = (name: string) => persistedEnvVarNames.includes(name);
  const isRuntime = (name: string) => Boolean(process.env[name]?.trim());
  const isSatisfied = (name: string) => isRuntime(name) || isSaved(name);
  const buildField = (input: {
    envVarName: string;
    label: string;
    secret?: boolean;
    required?: boolean;
  }) => ({
    envVarName: input.envVarName,
    acceptedEnvVarNames: [input.envVarName],
    label: input.label,
    ...(input.secret ? { secret: true } : {}),
    ...(input.required === false ? { required: false as const } : {}),
    runtimeSatisfied: isRuntime(input.envVarName),
    savedSatisfied: isSaved(input.envVarName),
    satisfiedByEnvVarName: isSatisfied(input.envVarName)
      ? input.envVarName
      : null,
  });

  return {
    ...status,
    providers: [
      ...status.providers,
      {
        id: 'telegram',
        label: 'Telegram',
        fields: [
          buildField({
            envVarName: 'TELEGRAM_BOT_TOKEN',
            label: 'Telegram Bot Token',
            secret: true,
          }),
          buildField({
            envVarName: 'TELEGRAM_WEBHOOK_SECRET',
            label: 'Telegram Webhook Secret',
            secret: true,
          }),
          buildField({
            envVarName: 'TELEGRAM_BOT_USERNAME',
            label: 'Telegram Bot Username',
            required: false,
          }),
        ],
        runtimeSatisfied:
          isRuntime('TELEGRAM_BOT_TOKEN') &&
          isRuntime('TELEGRAM_WEBHOOK_SECRET'),
        savedSatisfied:
          isSaved('TELEGRAM_BOT_TOKEN') && isSaved('TELEGRAM_WEBHOOK_SECRET'),
        setupSatisfied:
          isSatisfied('TELEGRAM_BOT_TOKEN') &&
          isSatisfied('TELEGRAM_WEBHOOK_SECRET'),
        telegramWebhook,
      },
    ],
  };
}

export async function getCommsStatusCommand(
  auth: UserAuthSuccess,
): Promise<CommsStatus> {
  assertAdmin(auth);

  const [persistedEnvVarNames, telegramWebhook] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getTelegramWebhookStatus(),
  ]);

  return withTelegramProvider(
    buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
    }),
    {
      persistedEnvVarNames,
      telegramWebhook,
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
              envVarName: 'TELEGRAM_BOT_TOKEN',
              acceptedEnvVarNames: ['TELEGRAM_BOT_TOKEN'],
              label: 'Telegram Bot Token',
              secret: true,
            },
            {
              envVarName: 'TELEGRAM_WEBHOOK_SECRET',
              acceptedEnvVarNames: ['TELEGRAM_WEBHOOK_SECRET'],
              label: 'Telegram Webhook Secret',
              secret: true,
              required: false,
            },
            {
              envVarName: 'TELEGRAM_BOT_USERNAME',
              acceptedEnvVarNames: ['TELEGRAM_BOT_USERNAME'],
              label: 'Telegram Bot Username',
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
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

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
        input.values?.TELEGRAM_WEBHOOK_SECRET?.trim() ??
        (providerStatus.fields.find(
          (field) => field.envVarName === 'TELEGRAM_WEBHOOK_SECRET',
        )?.savedSatisfied
          ? undefined
          : createTelegramWebhookSecret());
      if (telegramWebhookSecret) {
        valuesToSave.push({
          name: 'TELEGRAM_WEBHOOK_SECRET',
          value: telegramWebhookSecret,
        });
      }
    }

    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        nextValue.length === 0
      );
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
            { acceptedEnvVarNames: ['TELEGRAM_BOT_TOKEN'] },
            { acceptedEnvVarNames: ['TELEGRAM_WEBHOOK_SECRET'] },
            { acceptedEnvVarNames: ['TELEGRAM_BOT_USERNAME'] },
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

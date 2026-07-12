import {
  resolveTeamsBotCredentialEnvVarNames,
  type TeamsBotInferredFieldEnvVarName,
} from './teams-bot-credentials';

export const SETUP_AUTH_PROVIDER_IDS = ['slack', 'microsoft'] as const;

export type SetupAuthProviderId = (typeof SETUP_AUTH_PROVIDER_IDS)[number];

export type SetupAuthProviderFieldDescriptor = {
  envVarName: string;
  acceptedEnvVarNames: readonly string[];
  label: string;
  required?: boolean;
  secret?: boolean;
};

export type SetupAuthProviderDescriptor = {
  id: SetupAuthProviderId;
  label: string;
  fields: readonly SetupAuthProviderFieldDescriptor[];
};

export type SetupAuthProviderFieldStatus = SetupAuthProviderFieldDescriptor & {
  runtimeSatisfied: boolean;
  savedSatisfied: boolean;
  /** Plain-text value for non-secret fields; secrets never round-trip here. */
  savedValue?: string | null;
  satisfiedByEnvVarName: string | null;
};

export type SetupAuthProviderStatus = Omit<
  SetupAuthProviderDescriptor,
  'fields'
> & {
  fields: SetupAuthProviderFieldStatus[];
  runtimeSatisfied: boolean;
  savedSatisfied: boolean;
  setupSatisfied: boolean;
};

export type SetupProviderLockReason = 'runtime_env' | null;

export type SetupAuthStatus = {
  selectedProvider: SetupAuthProviderId | null;
  preselectedProvider: SetupAuthProviderId;
  runtimeConfiguredProvider: SetupAuthProviderId | null;
  runtimeConfiguredProviders: SetupAuthProviderId[];
  lockReason: SetupProviderLockReason;
  providers: SetupAuthProviderStatus[];
  setupSatisfiedByRuntimeEnv: boolean;
};

export const DEFAULT_SETUP_AUTH_PROVIDER_ID: SetupAuthProviderId = 'slack';

const SETUP_AUTH_PROVIDER_ID_SET = new Set<string>(SETUP_AUTH_PROVIDER_IDS);

export function isSetupAuthProviderId(
  value: unknown,
): value is SetupAuthProviderId {
  return typeof value === 'string' && SETUP_AUTH_PROVIDER_ID_SET.has(value);
}

export const SETUP_AUTH_PROVIDER_CATALOG = [
  {
    id: 'slack',
    label: 'Slack',
    fields: [
      {
        envVarName: 'R_SLACK_CLIENT_ID',
        acceptedEnvVarNames: ['R_SLACK_CLIENT_ID'],
        label: 'Slack Client ID',
      },
      {
        envVarName: 'R_SLACK_CLIENT_SECRET',
        acceptedEnvVarNames: ['R_SLACK_CLIENT_SECRET'],
        label: 'Slack Client Secret',
        secret: true,
      },
      {
        envVarName: 'R_SLACK_SIGNING_SECRET',
        acceptedEnvVarNames: ['R_SLACK_SIGNING_SECRET'],
        label: 'Slack Signing Secret',
        secret: true,
      },
    ],
  },
  {
    id: 'microsoft',
    label: 'Microsoft Teams',
    fields: [
      {
        envVarName: 'R_MICROSOFT_CLIENT_ID',
        acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_ID'],
        label: 'App (Client) ID',
      },
      {
        envVarName: 'R_MICROSOFT_CLIENT_SECRET',
        acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_SECRET'],
        label: 'Client Secret Value',
        secret: true,
      },
      {
        envVarName: 'R_MICROSOFT_TENANT_ID',
        acceptedEnvVarNames: ['R_MICROSOFT_TENANT_ID'],
        label: 'Directory (Tenant) ID',
      },
      {
        envVarName: 'R_TEAMS_BOT_APP_ID',
        acceptedEnvVarNames: ['R_TEAMS_BOT_APP_ID'],
        label: 'Teams Bot App ID',
      },
      {
        envVarName: 'R_TEAMS_BOT_APP_PASSWORD',
        acceptedEnvVarNames: ['R_TEAMS_BOT_APP_PASSWORD'],
        label: 'Teams Bot App Password',
        secret: true,
      },
      {
        envVarName: 'R_TEAMS_BOT_TENANT_ID',
        acceptedEnvVarNames: ['R_TEAMS_BOT_TENANT_ID'],
        label: 'Teams Bot Tenant ID',
      },
      {
        envVarName: 'R_TEAMS_BOT_NAME',
        acceptedEnvVarNames: ['R_TEAMS_BOT_NAME'],
        label: 'Teams Bot Display Name',
        required: false,
      },
      {
        envVarName: 'R_TEAMS_BOT_TOKEN_ENDPOINT',
        acceptedEnvVarNames: ['R_TEAMS_BOT_TOKEN_ENDPOINT'],
        label: 'Teams Bot Token Endpoint',
        required: false,
      },
      {
        envVarName: 'R_TEAMS_BOT_OAUTH_SCOPE',
        acceptedEnvVarNames: ['R_TEAMS_BOT_OAUTH_SCOPE'],
        label: 'Teams Bot OAuth Scope',
        required: false,
      },
    ],
  },
] as const satisfies readonly SetupAuthProviderDescriptor[];

const SETUP_AUTH_PROVIDER_BY_ID = new Map<
  SetupAuthProviderId,
  SetupAuthProviderDescriptor
>(SETUP_AUTH_PROVIDER_CATALOG.map((provider) => [provider.id, provider]));

export const COMMS_PROVIDER_ENV_VAR_NAMES: ReadonlySet<string> = new Set(
  SETUP_AUTH_PROVIDER_CATALOG.flatMap((provider) =>
    provider.fields.flatMap((field) => [...field.acceptedEnvVarNames]),
  ),
);

function isRequiredField(field: SetupAuthProviderFieldDescriptor) {
  return field.required !== false;
}

function isConfiguredEnvValue(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getSetupAuthProvider(
  providerId: SetupAuthProviderId,
): SetupAuthProviderDescriptor {
  return (
    SETUP_AUTH_PROVIDER_BY_ID.get(providerId) ?? SETUP_AUTH_PROVIDER_CATALOG[0]
  );
}

export function buildSetupAuthStatus(input: {
  runtimeEnv?: Partial<Record<string, string | undefined>> | null;
  persistedEnvVarNames?: Iterable<string>;
  selectedProvider?: SetupAuthProviderId | null;
}): SetupAuthStatus {
  const runtimeEnv = input.runtimeEnv ?? {};
  const persistedEnvVarNameSet = new Set(
    Array.from(input.persistedEnvVarNames ?? []).map((name) => name.trim()),
  );

  const effectiveTeamsBotCredentialEnvVarNames =
    resolveTeamsBotCredentialEnvVarNames({
      hasConfiguredEnvVar: (name) =>
        isConfiguredEnvValue(runtimeEnv[name]) ||
        persistedEnvVarNameSet.has(name),
    }).fieldSourceEnvVarNames;

  const providers = SETUP_AUTH_PROVIDER_CATALOG.map((provider) => {
    const fields = provider.fields.map((field) => {
      const inferredMatch =
        provider.id === 'microsoft'
          ? effectiveTeamsBotCredentialEnvVarNames[
              field.envVarName as TeamsBotInferredFieldEnvVarName
            ]
          : undefined;
      const runtimeMatch =
        (inferredMatch && isConfiguredEnvValue(runtimeEnv[inferredMatch])
          ? inferredMatch
          : undefined) ??
        field.acceptedEnvVarNames.find((envVarName) =>
          isConfiguredEnvValue(runtimeEnv[envVarName]),
        );
      const savedMatch =
        (inferredMatch && persistedEnvVarNameSet.has(inferredMatch)
          ? inferredMatch
          : undefined) ??
        field.acceptedEnvVarNames.find((envVarName) =>
          persistedEnvVarNameSet.has(envVarName),
        );

      return {
        ...field,
        runtimeSatisfied: runtimeMatch !== undefined,
        savedSatisfied: savedMatch !== undefined,
        satisfiedByEnvVarName: runtimeMatch ?? savedMatch ?? null,
      };
    });

    return {
      ...provider,
      fields,
      runtimeSatisfied: fields
        .filter(isRequiredField)
        .every((field) => field.runtimeSatisfied),
      savedSatisfied: fields
        .filter(isRequiredField)
        .every((field) => field.savedSatisfied),
      setupSatisfied: fields
        .filter(isRequiredField)
        .every((field) => field.runtimeSatisfied || field.savedSatisfied),
    };
  });

  const runtimeProvider =
    providers.find((provider) => provider.runtimeSatisfied) ?? null;
  const runtimeConfiguredProviders = providers
    .filter((provider) => provider.runtimeSatisfied)
    .map((provider) => provider.id);
  const savedProvider = providers.find((provider) => provider.setupSatisfied);
  const requestedSelectedProvider = isSetupAuthProviderId(
    input.selectedProvider,
  )
    ? input.selectedProvider
    : null;

  const preselectedProvider =
    runtimeProvider?.id ??
    requestedSelectedProvider ??
    savedProvider?.id ??
    DEFAULT_SETUP_AUTH_PROVIDER_ID;
  const selectedProvider =
    input.selectedProvider !== undefined
      ? requestedSelectedProvider
      : (runtimeProvider?.id ?? null);
  const selectedProviderStatus =
    providers.find((provider) => provider.id === selectedProvider) ?? null;

  return {
    selectedProvider,
    preselectedProvider,
    runtimeConfiguredProvider: runtimeProvider?.id ?? null,
    runtimeConfiguredProviders,
    lockReason: runtimeProvider ? 'runtime_env' : null,
    providers,
    setupSatisfiedByRuntimeEnv:
      input.selectedProvider !== undefined && requestedSelectedProvider !== null
        ? selectedProviderStatus?.runtimeSatisfied === true
        : runtimeProvider !== null,
  };
}

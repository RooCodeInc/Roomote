import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  sourceControlProviders,
  sourceControlProviderDescriptors,
  type SourceControlConnectionMode,
  type SourceControlProvider,
} from './source-control';
import type { SetupProviderLockReason } from './setup-auth-config';

export type SetupSourceControlFieldDescriptor = {
  envVarName: string;
  acceptedEnvVarNames: readonly string[];
  label: string;
  required?: boolean;
  secret?: boolean;
  settingsHidden?: boolean;
  /** Hidden in onboarding until “Show advanced config” is opened. */
  advanced?: boolean;
  /** Never shown in onboarding; remaining available in Settings/backend. */
  setupHidden?: boolean;
};

export type SetupSourceControlProviderDescriptor = {
  provider: SourceControlProvider;
  label: string;
  connectionMode: SourceControlConnectionMode;
  fields: readonly SetupSourceControlFieldDescriptor[];
};

export type SetupSourceControlFieldStatus =
  SetupSourceControlFieldDescriptor & {
    runtimeSatisfied: boolean;
    savedSatisfied: boolean;
    /** Plain-text value for non-secret fields; secrets never round-trip here. */
    savedValue?: string | null;
    satisfiedByEnvVarName: string | null;
  };

export type SetupSourceControlProviderStatus = Omit<
  SetupSourceControlProviderDescriptor,
  'fields'
> & {
  fields: SetupSourceControlFieldStatus[];
  runtimeConfigSatisfied: boolean;
  savedConfigSatisfied: boolean;
  configSatisfied: boolean;
  configSatisfiedByRuntimeEnv: boolean;
  connected: boolean;
  repositoryCount: number;
};

export type SetupSourceControlStatus = {
  selectedProvider: SourceControlProvider | null;
  preselectedProvider: SourceControlProvider;
  runtimeConfiguredProvider: SourceControlProvider | null;
  runtimeConfiguredProviders: SourceControlProvider[];
  lockReason: SetupProviderLockReason;
  connectedProvider: SourceControlProvider | null;
  providers: SetupSourceControlProviderStatus[];
  setupSatisfied: boolean;
  setupSatisfiedByRuntimeEnv: boolean;
  /**
   * Effective GitLab base URL resolved server-side (process env first, then
   * encrypted deployment env vars). Non-secret; lets setup UI link to the
   * correct self-managed GitLab host even when the saved value is not
   * present in the form.
   */
  gitlabBaseUrl?: string | null;
};

export const SETUP_SOURCE_CONTROL_PROVIDER_IDS = sourceControlProviders;

export function isRequiredField(field: SetupSourceControlFieldDescriptor) {
  return field.required !== false;
}

/**
 * Fields shown during `/setup` source-control configuration.
 * Settings continues to use the full field list for every provider.
 */
export function getSetupSourceControlVisibleFields<
  TField extends SetupSourceControlFieldDescriptor,
>(
  fields: readonly TField[],
  options: { showAdvancedConfig?: boolean } = {},
): TField[] {
  return fields.filter((field) => {
    if (field.setupHidden) {
      return false;
    }

    if (field.advanced && !options.showAdvancedConfig) {
      return false;
    }

    return true;
  });
}

function isSecretSourceControlField(
  field: Pick<SetupSourceControlFieldDescriptor, 'secret'>,
): boolean {
  return field.secret === true;
}

function isConfiguredEnvValue(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getAdoFieldValue(
  fields: readonly SetupSourceControlFieldStatus[],
  envVarName: string,
): string | null {
  return (
    fields
      .find((field) => field.envVarName === envVarName)
      ?.savedValue?.trim() ?? null
  );
}

function isAdoCredentialConfigured(
  fields: readonly SetupSourceControlFieldStatus[],
  kind: 'runtime' | 'saved' | 'effective',
): boolean {
  const isConfigured = (envVarName: string) =>
    fields.some((field) => {
      if (field.envVarName !== envVarName) return false;
      return kind === 'runtime'
        ? field.runtimeSatisfied
        : kind === 'saved'
          ? field.savedSatisfied
          : field.runtimeSatisfied || field.savedSatisfied;
    });
  const authMode = getAdoFieldValue(fields, 'ADO_AUTH_MODE');
  if (authMode === 'pat') return isConfigured('ADO_TOKEN');
  if (!authMode && isConfigured('ADO_TOKEN')) return true;

  const hasAppCredentials = [
    'ADO_CLIENT_ID',
    'ADO_CLIENT_SECRET',
    'ADO_TENANT_ID',
  ].every(isConfigured);
  if (!hasAppCredentials) return false;

  return authMode !== 'delegated' || isConfigured('ADO_LINKED_ACCOUNT_ID');
}

export const SETUP_SOURCE_CONTROL_PROVIDER_CATALOG = sourceControlProviders.map(
  (provider): SetupSourceControlProviderDescriptor => {
    const descriptor = sourceControlProviderDescriptors[provider];

    return {
      provider,
      label: descriptor.label,
      connectionMode: descriptor.connectionMode,
      fields: buildProviderFields(provider),
    };
  },
);

/**
 * Non-secret source-control env var names (including accepted aliases) that
 * the Settings/setup UIs may surface as plain text via `savedValue`.
 */
export const NON_SECRET_SOURCE_CONTROL_ENV_VAR_NAMES: readonly string[] = [
  ...new Set(
    SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.flatMap((descriptor) =>
      descriptor.fields
        .filter((field) => !isSecretSourceControlField(field))
        .flatMap((field) => field.acceptedEnvVarNames),
    ),
  ),
];

const SETUP_SOURCE_CONTROL_PROVIDER_BY_PROVIDER = new Map<
  SourceControlProvider,
  SetupSourceControlProviderDescriptor
>(
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.map((descriptor) => [
    descriptor.provider,
    descriptor,
  ]),
);

const DEFAULT_SETUP_SOURCE_CONTROL_PROVIDER_DESCRIPTOR: SetupSourceControlProviderDescriptor =
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.find(
    (descriptor) => descriptor.provider === DEFAULT_SOURCE_CONTROL_PROVIDER,
  )!;

export function getSetupSourceControlProvider(
  provider: SourceControlProvider,
): SetupSourceControlProviderDescriptor {
  return (
    SETUP_SOURCE_CONTROL_PROVIDER_BY_PROVIDER.get(provider) ??
    DEFAULT_SETUP_SOURCE_CONTROL_PROVIDER_DESCRIPTOR
  );
}

function buildProviderFields(
  provider: SourceControlProvider,
): readonly SetupSourceControlFieldDescriptor[] {
  switch (provider) {
    case 'github':
      return [
        {
          envVarName: 'R_GITHUB_APP_SLUG',
          acceptedEnvVarNames: ['R_GITHUB_APP_SLUG'],
          label: 'GitHub App Slug',
        },
        {
          envVarName: 'R_GITHUB_APP_ID',
          acceptedEnvVarNames: ['R_GITHUB_APP_ID'],
          label: 'GitHub App ID',
        },
        {
          envVarName: 'R_GITHUB_APP_PRIVATE_KEY',
          acceptedEnvVarNames: ['R_GITHUB_APP_PRIVATE_KEY'],
          label: 'GitHub App Private Key',
          secret: true,
        },
        {
          envVarName: 'R_GITHUB_CLIENT_ID',
          acceptedEnvVarNames: ['R_GITHUB_CLIENT_ID'],
          label: 'GitHub OAuth Client ID',
        },
        {
          envVarName: 'R_GITHUB_CLIENT_SECRET',
          acceptedEnvVarNames: ['R_GITHUB_CLIENT_SECRET'],
          label: 'GitHub OAuth Client Secret',
          secret: true,
        },
        {
          envVarName: 'R_GITHUB_WEBHOOK_SECRET',
          acceptedEnvVarNames: ['R_GITHUB_WEBHOOK_SECRET'],
          label: 'GitHub Webhook Secret',
          secret: true,
        },
      ];
    case 'gitlab':
      return [
        {
          envVarName: 'GITLAB_TOKEN',
          acceptedEnvVarNames: ['GITLAB_TOKEN'],
          label: 'GitLab Automation Token',
          secret: true,
          required: false,
          advanced: true,
        },
        {
          envVarName: 'GITLAB_BASE_URL',
          acceptedEnvVarNames: ['GITLAB_BASE_URL'],
          label: 'GitLab Base URL',
          required: false,
        },
        {
          envVarName: 'GITLAB_CLIENT_ID',
          acceptedEnvVarNames: ['GITLAB_CLIENT_ID'],
          label: 'GitLab OAuth Client ID',
          required: false,
        },
        {
          envVarName: 'GITLAB_CLIENT_SECRET',
          acceptedEnvVarNames: ['GITLAB_CLIENT_SECRET'],
          label: 'GitLab OAuth Client Secret',
          secret: true,
          required: false,
        },
        {
          envVarName: 'GITLAB_WEBHOOK_SIGNING_TOKEN',
          acceptedEnvVarNames: ['GITLAB_WEBHOOK_SIGNING_TOKEN'],
          label: 'GitLab Webhook Signing Token',
          secret: true,
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'GITLAB_WEBHOOK_SECRET',
          acceptedEnvVarNames: ['GITLAB_WEBHOOK_SECRET'],
          label: 'GitLab Webhook Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
      ];
    case 'gitea':
      return [
        {
          envVarName: 'GITEA_BASE_URL',
          acceptedEnvVarNames: ['GITEA_BASE_URL'],
          label: 'Gitea Base URL',
        },
        {
          envVarName: 'GITEA_TOKEN',
          acceptedEnvVarNames: ['GITEA_TOKEN'],
          label: 'Gitea Access Token',
          secret: true,
        },
        {
          envVarName: 'GITEA_USERNAME',
          acceptedEnvVarNames: ['GITEA_USERNAME'],
          label: 'Gitea Username',
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'GITEA_CLIENT_ID',
          acceptedEnvVarNames: ['GITEA_CLIENT_ID'],
          label: 'Gitea OAuth Client ID',
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'GITEA_CLIENT_SECRET',
          acceptedEnvVarNames: ['GITEA_CLIENT_SECRET'],
          label: 'Gitea OAuth Client Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'GITEA_WEBHOOK_SECRET',
          acceptedEnvVarNames: ['GITEA_WEBHOOK_SECRET'],
          label: 'Gitea Webhook Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
      ];
    case 'ado':
      return [
        {
          envVarName: 'ADO_ORGANIZATION',
          acceptedEnvVarNames: ['ADO_ORGANIZATION'],
          label: 'Azure DevOps Organization',
        },
        {
          envVarName: 'ADO_TOKEN',
          acceptedEnvVarNames: ['ADO_TOKEN'],
          label: 'Azure DevOps Access Token',
          secret: true,
          required: false,
        },
        {
          envVarName: 'ADO_AUTH_MODE',
          acceptedEnvVarNames: ['ADO_AUTH_MODE'],
          label: 'Azure DevOps Authentication Mode',
          required: false,
          setupHidden: true,
          settingsHidden: true,
        },
        {
          envVarName: 'ADO_LINKED_ACCOUNT_ID',
          acceptedEnvVarNames: ['ADO_LINKED_ACCOUNT_ID'],
          label: 'Azure DevOps Linked Account ID',
          required: false,
          setupHidden: true,
          settingsHidden: true,
        },
        {
          envVarName: 'ADO_BASE_URL',
          acceptedEnvVarNames: ['ADO_BASE_URL'],
          label: 'Azure DevOps Base URL',
          required: false,
          advanced: true,
        },
        {
          envVarName: 'ADO_USERNAME',
          acceptedEnvVarNames: ['ADO_USERNAME'],
          label: 'Azure DevOps Username',
          required: false,
          advanced: true,
        },
        {
          envVarName: 'ADO_CLIENT_ID',
          acceptedEnvVarNames: ['ADO_CLIENT_ID'],
          label: 'Microsoft Entra Client ID',
          required: false,
        },
        {
          envVarName: 'ADO_CLIENT_SECRET',
          acceptedEnvVarNames: ['ADO_CLIENT_SECRET'],
          label: 'Microsoft Entra Client Secret',
          secret: true,
          required: false,
        },
        {
          envVarName: 'ADO_TENANT_ID',
          acceptedEnvVarNames: ['ADO_TENANT_ID'],
          label: 'Microsoft Entra Tenant ID',
          required: false,
        },
        {
          envVarName: 'ADO_WEBHOOK_SECRET',
          acceptedEnvVarNames: ['ADO_WEBHOOK_SECRET'],
          label: 'Azure DevOps Webhook Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
      ];
    case 'bitbucket':
      return [
        {
          envVarName: 'BITBUCKET_TOKEN',
          acceptedEnvVarNames: ['BITBUCKET_TOKEN'],
          label: 'Bitbucket API Token',
          secret: true,
        },
        {
          envVarName: 'BITBUCKET_USERNAME',
          acceptedEnvVarNames: ['BITBUCKET_USERNAME'],
          label: 'Atlassian Account Email',
        },
        {
          envVarName: 'BITBUCKET_BASE_URL',
          acceptedEnvVarNames: ['BITBUCKET_BASE_URL'],
          label: 'Bitbucket Base URL',
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'BITBUCKET_CLIENT_ID',
          acceptedEnvVarNames: ['BITBUCKET_CLIENT_ID'],
          label: 'Bitbucket OAuth Client ID',
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'BITBUCKET_CLIENT_SECRET',
          acceptedEnvVarNames: ['BITBUCKET_CLIENT_SECRET'],
          label: 'Bitbucket OAuth Client Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
        {
          envVarName: 'BITBUCKET_WEBHOOK_SECRET',
          acceptedEnvVarNames: ['BITBUCKET_WEBHOOK_SECRET'],
          label: 'Bitbucket Webhook Secret',
          secret: true,
          required: false,
          setupHidden: true,
        },
      ];
  }
}

export function buildSetupSourceControlStatus(input: {
  runtimeEnv?: Partial<Record<string, string | undefined>> | null;
  persistedEnvVarNames?: Iterable<string>;
  persistedEnvVarValues?: Partial<Record<string, string>>;
  selectedProvider?: SourceControlProvider | null;
  connectedProviders?: Iterable<SourceControlProvider>;
  repositoryCounts?: Partial<Record<SourceControlProvider, number>>;
  gitlabBaseUrl?: string | null;
}): SetupSourceControlStatus {
  const runtimeEnv = input.runtimeEnv ?? {};
  const persistedEnvVarNameSet = new Set(
    Array.from(input.persistedEnvVarNames ?? []).map((name) => name.trim()),
  );
  const persistedEnvVarValues = input.persistedEnvVarValues ?? {};
  const connectedProviderSet = new Set(input.connectedProviders ?? []);
  const repositoryCounts = input.repositoryCounts ?? {};

  const providers = SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.map((descriptor) => {
    const fields = descriptor.fields.map((field) => {
      const runtimeMatch = field.acceptedEnvVarNames.find((envVarName) =>
        isConfiguredEnvValue(runtimeEnv[envVarName]),
      );
      const savedMatch = field.acceptedEnvVarNames.find((envVarName) =>
        persistedEnvVarNameSet.has(envVarName),
      );
      const runtimeValue = runtimeMatch
        ? runtimeEnv[runtimeMatch]?.trim() || null
        : null;
      const persistedValue = savedMatch
        ? persistedEnvVarValues[savedMatch]?.trim() || null
        : null;
      const savedValue = isSecretSourceControlField(field)
        ? null
        : (runtimeValue ?? persistedValue);

      return {
        ...field,
        runtimeSatisfied: runtimeMatch !== undefined,
        savedSatisfied: savedMatch !== undefined,
        savedValue,
        satisfiedByEnvVarName: runtimeMatch ?? savedMatch ?? null,
      };
    });

    const requiredFields = fields.filter(isRequiredField);
    const runtimeConfigSatisfied = requiredFields.every(
      (field) => field.runtimeSatisfied,
    );
    const savedConfigSatisfied = requiredFields.every(
      (field) => field.savedSatisfied,
    );
    const standardConfigSatisfied = requiredFields.every(
      (field) => field.runtimeSatisfied || field.savedSatisfied,
    );
    const adoCredentialSatisfied =
      descriptor.provider !== 'ado' ||
      isAdoCredentialConfigured(fields, 'effective');
    const adoRuntimeCredentialSatisfied =
      descriptor.provider !== 'ado' ||
      isAdoCredentialConfigured(fields, 'runtime');
    const adoSavedCredentialSatisfied =
      descriptor.provider !== 'ado' ||
      isAdoCredentialConfigured(fields, 'saved');
    const configSatisfied = standardConfigSatisfied && adoCredentialSatisfied;

    return {
      ...descriptor,
      fields,
      runtimeConfigSatisfied:
        runtimeConfigSatisfied && adoRuntimeCredentialSatisfied,
      savedConfigSatisfied: savedConfigSatisfied && adoSavedCredentialSatisfied,
      configSatisfied,
      configSatisfiedByRuntimeEnv:
        runtimeConfigSatisfied && adoRuntimeCredentialSatisfied,
      connected: connectedProviderSet.has(descriptor.provider),
      repositoryCount: repositoryCounts[descriptor.provider] ?? 0,
    };
  });

  const connectedProvider =
    providers.find(
      (candidate) => candidate.provider === 'github' && candidate.connected,
    )?.provider ??
    providers.find((candidate) => candidate.connected)?.provider ??
    null;

  const runtimeConfiguredProvider =
    providers.find(
      (candidate) =>
        candidate.provider === 'github' && candidate.runtimeConfigSatisfied,
    )?.provider ??
    providers.find((candidate) => candidate.runtimeConfigSatisfied)?.provider ??
    null;
  const runtimeConfiguredProviders = providers
    .filter((candidate) => candidate.runtimeConfigSatisfied)
    .map((candidate) => candidate.provider);

  const savedConfiguredProvider =
    providers.find(
      (candidate) =>
        candidate.provider === 'github' && candidate.configSatisfied,
    )?.provider ??
    providers.find((candidate) => candidate.configSatisfied)?.provider ??
    null;

  const preselectedProvider =
    connectedProvider ??
    runtimeConfiguredProvider ??
    input.selectedProvider ??
    savedConfiguredProvider ??
    DEFAULT_SOURCE_CONTROL_PROVIDER;

  const selectedProvider =
    input.selectedProvider ??
    connectedProvider ??
    runtimeConfiguredProvider ??
    null;

  const setupSatisfied = connectedProvider !== null;
  const connectedProviderStatus = connectedProvider
    ? providers.find((candidate) => candidate.provider === connectedProvider)
    : null;
  const setupSatisfiedByRuntimeEnv =
    setupSatisfied &&
    (connectedProviderStatus?.configSatisfiedByRuntimeEnv ?? false);

  return {
    selectedProvider,
    preselectedProvider,
    runtimeConfiguredProvider,
    runtimeConfiguredProviders,
    lockReason: runtimeConfiguredProvider ? 'runtime_env' : null,
    connectedProvider,
    providers,
    setupSatisfied,
    setupSatisfiedByRuntimeEnv,
    gitlabBaseUrl: input.gitlabBaseUrl?.trim() || null,
  };
}

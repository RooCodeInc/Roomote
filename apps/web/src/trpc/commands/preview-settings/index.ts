import { Env } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import {
  db,
  deploymentSettings,
  eq,
  resolveEffectivePreviewRuntimeConfig,
} from '@roomote/db/server';
import {
  areDeploymentPreviewsEnabled,
  normalizeMetadataRecord,
  setDeploymentPreviewsEnabled,
} from '@roomote/feature-flags';
import {
  analyzePreviewRuntimeConfig,
  buildExamplePreviewHostname,
  deriveRoomotePreviewDomain,
  hasAdvancedPreviewConfig,
  hasConfiguredPreviewPorts,
  isEnvironmentPreviewEnabledInConfig,
  isLocalPreviewDomain,
  type EnvironmentConfig,
  type NamedPort,
  PREVIEW_DOMAIN_ENV_VAR,
  PREVIEW_PROXY_BASE_URL_ENV_VAR,
  type PreviewRuntimeConfigFields,
} from '@roomote/types';

import {
  getEnvironmentByIdCommand,
  getEnvironmentsCommand,
  updateEnvironmentCommand,
  type EnvironmentWithMeta,
} from '../environments';
import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

const DEFAULT_DEPLOYMENT_ID = 'default';

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

type RuntimePreviewValidation = {
  status: 'pass' | 'fail';
  reason:
    | 'config_ready'
    | 'missing_runtime_config'
    | 'validation_failed'
    | 'probe_failed';
  summary: string;
  details: string[];
  checkedHostname: string | null;
};

export type PreviewSettingsStatus =
  | 'disabled'
  | 'configured_but_off'
  | 'missing_runtime_config'
  | 'ready'
  | 'validation_failed';

export interface PreviewSettingsEnvironmentSummary {
  id: string;
  name: string;
  description: string | null;
  config: Pick<EnvironmentConfig, 'ports' | 'previews_enabled'>;
  previewState: {
    status:
      | 'ready'
      | 'deployment_disabled'
      | 'runtime_unavailable'
      | 'environment_disabled'
      | 'not_configured';
    label: string;
  };
  hasAdvancedPreviewConfig: boolean;
  primaryPortName: string | null;
}

export interface PreviewSettingsSnapshot {
  deployment: {
    previewsEnabled: boolean;
    status: PreviewSettingsStatus;
    statusLabel: string;
    effectiveAvailability: boolean;
  };
  persistedConfig: {
    previewProxyBaseUrl: string;
    roomotePreviewDomain: string | null;
  };
  effectiveConfig: {
    previewProxyBaseUrl: string | null;
    previewProxyHostname: string | null;
    previewDomains: string[];
    roomotePreviewDomain: string | null;
    primaryPreviewDomain: string | null;
    exampleHostname: string | null;
    validation: RuntimePreviewValidation;
  };
  overrideState: {
    hasOverrides: boolean;
    overriddenFields: Array<
      'previewProxyBaseUrl' | 'previewDomains' | 'roomotePreviewDomain'
    >;
  };
  configSource: {
    previewOrigin: 'env' | 'deployment' | 'default' | 'missing';
    previewOriginManagedByEnv: boolean;
  };
  environments: PreviewSettingsEnvironmentSummary[];
}

const REMOTE_PREVIEW_UI_MOCK_ENV_VAR = 'MOCK_LIVE_PREVIEWS_REMOTE_DOMAIN';

export function applyPreviewRuntimeUiMock(
  runtime: PreviewSettingsSnapshot['effectiveConfig'],
): PreviewSettingsSnapshot['effectiveConfig'] {
  if (process.env.NODE_ENV === 'production') {
    return runtime;
  }

  const mockDomain = process.env[REMOTE_PREVIEW_UI_MOCK_ENV_VAR]?.trim();

  if (!mockDomain) {
    return runtime;
  }

  return {
    ...runtime,
    previewProxyBaseUrl: `https://${mockDomain}`,
    previewProxyHostname: mockDomain,
    previewDomains: [mockDomain],
    roomotePreviewDomain: mockDomain,
    primaryPreviewDomain: mockDomain,
    exampleHostname: buildExamplePreviewHostname(mockDomain),
    validation: {
      status: 'pass',
      reason: 'config_ready',
      summary: `Using mocked preview domain ${mockDomain} for local UI development.`,
      details: [],
      checkedHostname: null,
    },
  };
}

function buildEnvironmentPreviewState(params: {
  environment: EnvironmentWithMeta;
  deploymentEnabled: boolean;
  runtimeReady: boolean;
}): PreviewSettingsEnvironmentSummary['previewState'] {
  const { environment, deploymentEnabled, runtimeReady } = params;

  if (!hasConfiguredPreviewPorts(environment.config)) {
    return { status: 'not_configured', label: 'Not configured' };
  }

  if (!deploymentEnabled) {
    return { status: 'deployment_disabled', label: 'Configured but off' };
  }

  if (!runtimeReady) {
    return { status: 'runtime_unavailable', label: 'Unavailable' };
  }

  if (!isEnvironmentPreviewEnabledInConfig(environment.config)) {
    return { status: 'environment_disabled', label: 'Disabled' };
  }

  return { status: 'ready', label: 'Ready' };
}

function buildPrimaryPortName(ports: NamedPort[] | undefined): string | null {
  if (!ports?.length) {
    return null;
  }

  return ports.find((port) => port.primary)?.name ?? ports[0]?.name ?? null;
}

async function probePreviewHostname(
  previewProxyBaseUrl: string,
  hostname: string,
): Promise<RuntimePreviewValidation> {
  const probeUrl = new URL(previewProxyBaseUrl);
  probeUrl.hostname = `roomote-preview-check-${Date.now()}.${hostname}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 400) {
      return {
        status: 'pass',
        reason: 'config_ready',
        summary: 'Wildcard preview host responded.',
        details: [],
        checkedHostname: probeUrl.host,
      };
    }

    return {
      status: 'pass',
      reason: 'config_ready',
      summary: 'Wildcard preview host responded.',
      details: [`Probe returned HTTP ${response.status} for ${probeUrl.host}.`],
      checkedHostname: probeUrl.host,
    };
  } catch (error) {
    clearTimeout(timeout);

    const message =
      error instanceof Error ? error.message : 'Unknown probe failure';

    return {
      status: 'fail',
      reason: 'probe_failed',
      summary: 'Wildcard preview host did not respond.',
      details: [message],
      checkedHostname: probeUrl.host,
    };
  }
}

async function validateRuntimePreviewConfig(): Promise<
  PreviewSettingsSnapshot['effectiveConfig']
> {
  const resolvedConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });
  const analysis = resolvedConfig.analysis;

  let validation: RuntimePreviewValidation;

  if (!analysis.isReady) {
    validation = {
      status: 'fail',
      reason:
        analysis.status === 'missing_runtime_config'
          ? 'missing_runtime_config'
          : 'validation_failed',
      summary:
        analysis.status === 'missing_runtime_config'
          ? 'Preview runtime config is incomplete.'
          : 'Preview runtime config failed validation.',
      details: analysis.issues.map((issue) => issue.message),
      checkedHostname: null,
    };
  } else if (
    !analysis.primaryPreviewDomain ||
    !analysis.previewProxyBaseUrl ||
    isLocalPreviewDomain(analysis.primaryPreviewDomain)
  ) {
    validation = {
      status: 'pass',
      reason: 'config_ready',
      summary: 'Config is valid and checked',
      details: [],
      checkedHostname: null,
    };
  } else {
    validation = await probePreviewHostname(
      analysis.previewProxyBaseUrl,
      analysis.primaryPreviewDomain,
    );
  }

  return applyPreviewRuntimeUiMock({
    previewProxyBaseUrl: resolvedConfig.effective.previewProxyBaseUrl,
    previewProxyHostname: analysis.previewProxyHostname,
    previewDomains: analysis.previewDomains,
    roomotePreviewDomain: resolvedConfig.effective.roomotePreviewDomain,
    primaryPreviewDomain: analysis.primaryPreviewDomain,
    exampleHostname: analysis.primaryPreviewDomain
      ? buildExamplePreviewHostname(analysis.primaryPreviewDomain)
      : null,
    validation,
  });
}

function buildDeploymentStatus(params: {
  deploymentEnabled: boolean;
  runtimeValidation: RuntimePreviewValidation;
}): { status: PreviewSettingsStatus; statusLabel: string } {
  const { deploymentEnabled, runtimeValidation } = params;

  if (!deploymentEnabled) {
    if (runtimeValidation.status === 'pass') {
      return {
        status: 'configured_but_off',
        statusLabel: 'Configured but off',
      };
    }

    return { status: 'disabled', statusLabel: 'Disabled' };
  }

  if (runtimeValidation.status === 'fail') {
    return {
      status:
        runtimeValidation.reason === 'missing_runtime_config'
          ? 'missing_runtime_config'
          : 'validation_failed',
      statusLabel:
        runtimeValidation.reason === 'missing_runtime_config'
          ? 'Missing runtime config'
          : 'Validation failed',
    };
  }

  return { status: 'ready', statusLabel: 'Ready' };
}

export async function getPreviewSettingsCommand(
  auth: UserAuthSuccess,
): Promise<PreviewSettingsSnapshot> {
  assertAdmin(auth);

  const [deployment, environmentList, resolvedConfig, effectiveConfig] =
    await Promise.all([
      db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
        columns: { metadata: true },
      }),
      getEnvironmentsCommand(auth),
      resolveEffectivePreviewRuntimeConfig({
        runtimeEnv: process.env,
        defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
        defaultPreviewDomains: Env.PREVIEW_DOMAINS,
      }),
      validateRuntimePreviewConfig(),
    ]);

  const metadata = normalizeMetadataRecord(deployment?.metadata);
  const deploymentEnabled = areDeploymentPreviewsEnabled(metadata);
  const deploymentStatus = buildDeploymentStatus({
    deploymentEnabled,
    runtimeValidation: effectiveConfig.validation,
  });
  const runtimeReady = effectiveConfig.validation.status === 'pass';

  return {
    deployment: {
      previewsEnabled: deploymentEnabled,
      status: deploymentStatus.status,
      statusLabel: deploymentStatus.statusLabel,
      effectiveAvailability: deploymentEnabled && runtimeReady,
    },
    persistedConfig: {
      previewProxyBaseUrl: resolvedConfig.persisted.previewProxyBaseUrl ?? '',
      roomotePreviewDomain: resolvedConfig.persisted.roomotePreviewDomain,
    },
    effectiveConfig,
    overrideState: resolvedConfig.overrideState,
    configSource: {
      previewOrigin:
        resolvedConfig.sourceState.previewProxyBaseUrlSource === 'runtime_env'
          ? 'env'
          : resolvedConfig.sourceState.previewProxyBaseUrlSource === 'persisted'
            ? 'deployment'
            : resolvedConfig.sourceState.previewProxyBaseUrlSource,
      previewOriginManagedByEnv:
        resolvedConfig.sourceState.previewProxyBaseUrlManagedByRuntimeEnv,
    },
    environments: environmentList.map((environment) => ({
      id: environment.id,
      name: environment.name,
      description: environment.description,
      config: {
        ports: environment.config.ports,
        previews_enabled: environment.config.previews_enabled,
      },
      previewState: buildEnvironmentPreviewState({
        environment,
        deploymentEnabled,
        runtimeReady,
      }),
      hasAdvancedPreviewConfig: (environment.config.ports ?? []).some((port) =>
        hasAdvancedPreviewConfig(port),
      ),
      primaryPortName: buildPrimaryPortName(environment.config.ports),
    })),
  };
}

export async function setDeploymentPreviewEnabledCommand(
  auth: UserAuthSuccess,
  input: { enabled: boolean },
) {
  assertAdmin(auth);

  const existing = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  const metadata = setDeploymentPreviewsEnabled(
    existing?.metadata,
    input.enabled,
  );

  await db
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata,
        updatedAt: new Date(),
      },
    });

  return getPreviewSettingsCommand(auth);
}

type PreviewRuntimeConfigFieldErrors = Partial<
  Record<'previewProxyBaseUrl', string>
>;

function mapPreviewRuntimeFieldErrors(
  analysis: ReturnType<typeof analyzePreviewRuntimeConfig>,
  input: { previewProxyBaseUrl: string },
): PreviewRuntimeConfigFieldErrors {
  const fieldErrors: PreviewRuntimeConfigFieldErrors = {};

  if (input.previewProxyBaseUrl) {
    try {
      const url = new URL(input.previewProxyBaseUrl);

      if (
        url.pathname !== '/' ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        fieldErrors.previewProxyBaseUrl =
          'Preview origin must be only scheme, hostname, and optional port.';
        return fieldErrors;
      }
    } catch {
      // The analyzer reports invalid URLs below.
    }
  }

  for (const issue of analysis.issues) {
    if (
      issue.code === 'missing_base_url' ||
      issue.code === 'invalid_base_url'
    ) {
      fieldErrors.previewProxyBaseUrl ??= issue.message;
      continue;
    }
  }

  return fieldErrors;
}

function normalizePersistedRuntimeInput(
  input: Pick<PreviewRuntimeConfigFields, 'previewProxyBaseUrl'>,
) {
  const previewProxyBaseUrl = input.previewProxyBaseUrl?.trim() ?? '';
  const roomotePreviewDomain = deriveRoomotePreviewDomain(previewProxyBaseUrl);
  const analysis = analyzePreviewRuntimeConfig({
    previewProxyBaseUrl,
    previewDomains: roomotePreviewDomain,
    roomotePreviewDomain,
  });

  return {
    previewProxyBaseUrl,
    roomotePreviewDomain,
    analysis,
  };
}

export async function updatePreviewRuntimeConfigCommand(
  auth: UserAuthSuccess,
  input: {
    previewProxyBaseUrl: string;
  },
) {
  assertAdmin(auth);

  if ((process.env.PREVIEW_PROXY_BASE_URL ?? '').trim()) {
    return {
      success: false as const,
      fieldErrors: {
        previewProxyBaseUrl:
          'This value is managed by PREVIEW_PROXY_BASE_URL in the runtime environment and cannot be changed here.',
      },
    };
  }

  const normalized = normalizePersistedRuntimeInput(input);
  const fieldErrors = mapPreviewRuntimeFieldErrors(normalized.analysis, {
    previewProxyBaseUrl: normalized.previewProxyBaseUrl,
  });

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false as const,
      fieldErrors,
    };
  }

  await db.transaction(async (tx) => {
    await upsertDeploymentEnvironmentVariables(tx, {
      userId: auth.userId,
      values: [
        {
          name: PREVIEW_PROXY_BASE_URL_ENV_VAR,
          value: normalized.previewProxyBaseUrl,
        },
        {
          name: PREVIEW_DOMAIN_ENV_VAR,
          value: normalized.roomotePreviewDomain!,
        },
        {
          name: 'ROOMOTE_PREVIEW_DOMAIN',
          value: normalized.roomotePreviewDomain!,
        },
      ],
    });
  });

  return {
    success: true as const,
    snapshot: await getPreviewSettingsCommand(auth),
  };
}

export async function updateEnvironmentPreviewCommand(
  auth: UserAuthSuccess,
  input: {
    environmentId: string;
    previewsEnabled?: boolean;
    ports?: NamedPort[];
  },
) {
  assertAdmin(auth);

  const environment = await getEnvironmentByIdCommand(auth, {
    id: input.environmentId,
  });

  if (!environment) {
    return { success: false as const, error: 'Environment not found' };
  }

  const nextConfig: EnvironmentConfig = {
    ...environment.config,
    ...(input.previewsEnabled !== undefined
      ? { previews_enabled: input.previewsEnabled }
      : {}),
    ...(input.ports !== undefined ? { ports: input.ports } : {}),
  };

  return updateEnvironmentCommand(auth, {
    id: input.environmentId,
    config: nextConfig,
  });
}

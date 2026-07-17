import { Env } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  environments,
  eq,
  isNull,
  resolveEffectivePreviewRuntimeConfig,
  taskRuns,
  withEnvironmentVerificationRetryLock,
} from '@roomote/db/server';
import {
  analyzePreviewRuntimeConfig,
  appendEnvironmentDefinitionGuidance,
  buildEnvironmentDefinitionWorkspacePayload,
  buildExamplePreviewHostname,
  deriveRoomotePreviewDomain,
  ENVIRONMENT_PREVIEW_SETUP_CHANGE_REQUEST,
  hasConfiguredPreviewPorts,
  INTERNAL_PORTS,
  isLocalPreviewDomain,
  PREVIEW_DOMAIN_ENV_VAR,
  PREVIEW_PROXY_BASE_URL_ENV_VAR,
  TaskPayloadKind,
  type EnvironmentConfig,
  type PreviewRuntimeConfigFields,
  type RunStatus,
} from '@roomote/types';

import { buildUpdateEnvironmentDefinitionPrompt } from '@/lib/environment-definition';

import { getActiveEnvironmentAgentTask } from '../environments';
import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

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
  | 'missing_runtime_config'
  | 'ready'
  | 'validation_failed';

export interface PreviewSettingsSnapshot {
  runtime: {
    status: PreviewSettingsStatus;
    statusLabel: string;
    ready: boolean;
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
}

const REMOTE_PREVIEW_UI_MOCK_ENV_VAR = 'MOCK_LIVE_PREVIEWS_REMOTE_DOMAIN';

function isPreviewRuntimeUiMockActive(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    Boolean(process.env[REMOTE_PREVIEW_UI_MOCK_ENV_VAR]?.trim())
  );
}

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

function buildRuntimeStatus(validation: RuntimePreviewValidation): {
  status: PreviewSettingsStatus;
  statusLabel: string;
} {
  if (validation.status === 'pass') {
    return { status: 'ready', statusLabel: 'Ready' };
  }

  return validation.reason === 'missing_runtime_config'
    ? {
        status: 'missing_runtime_config',
        statusLabel: 'Missing runtime config',
      }
    : { status: 'validation_failed', statusLabel: 'Validation failed' };
}

export async function getPreviewSettingsCommand(
  auth: UserAuthSuccess,
): Promise<PreviewSettingsSnapshot> {
  assertAdmin(auth);

  const [resolvedConfig, effectiveConfig] = await Promise.all([
    resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.PREVIEW_DOMAINS,
    }),
    validateRuntimePreviewConfig(),
  ]);

  const runtimeStatus = buildRuntimeStatus(effectiveConfig.validation);

  return {
    runtime: {
      status: runtimeStatus.status,
      statusLabel: runtimeStatus.statusLabel,
      ready: effectiveConfig.validation.status === 'pass',
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
  };
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

export interface TaskPreviewStatus {
  runtimeReady: boolean;
  environment: {
    id: string;
    name: string;
    hasConfiguredPorts: boolean;
    portNames: string[];
  } | null;
  runHasPreviewDomains: boolean;
  setupTask: { taskId: string; status: RunStatus } | null;
}

async function resolveLatestTaskRunForTask(taskId: string) {
  return db.query.taskRuns.findFirst({
    columns: { payload: true, machineDomains: true },
    where: eq(taskRuns.taskId, taskId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

function getEnvironmentIdFromPayload(payload: unknown): string | null {
  const environmentId = (payload as { environmentId?: unknown } | undefined)
    ?.environmentId;

  return typeof environmentId === 'string' && environmentId.length > 0
    ? environmentId
    : null;
}

/**
 * Whether preview infrastructure is ready, matching the controller-side gate
 * that decides if environment ports publish preview domains. Deliberately skips
 * the DNS probe so this stays cheap enough to poll from the task page.
 */
async function isPreviewRuntimeReady(): Promise<boolean> {
  if (isPreviewRuntimeUiMockActive()) {
    return true;
  }

  const resolvedConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });

  return resolvedConfig.analysis.isReady;
}

async function loadDeploymentEnvironment(environmentId: string) {
  const [environment] = await db
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
    })
    .from(environments)
    .where(and(eq(environments.id, environmentId), isNull(environments.userId)))
    .limit(1);

  return environment
    ? { ...environment, config: environment.config as EnvironmentConfig }
    : null;
}

/**
 * Preview availability for a task, safe for non-admin viewers: exposes only
 * the environment id/name, port names, and readiness booleans. Admin-only
 * infrastructure details stay behind `getPreviewSettingsCommand`.
 */
export async function getTaskPreviewStatusCommand(
  _auth: UserAuthSuccess,
  input: { taskId: string },
): Promise<TaskPreviewStatus> {
  const [taskRun, runtimeReady] = await Promise.all([
    resolveLatestTaskRunForTask(input.taskId),
    isPreviewRuntimeReady(),
  ]);

  const environmentId = getEnvironmentIdFromPayload(taskRun?.payload);
  const runHasPreviewDomains = Object.keys(taskRun?.machineDomains ?? {}).some(
    (portName) => !INTERNAL_PORTS.has(portName),
  );

  if (!environmentId) {
    return {
      runtimeReady,
      environment: null,
      runHasPreviewDomains,
      setupTask: null,
    };
  }

  const [environment, setupTask] = await Promise.all([
    loadDeploymentEnvironment(environmentId),
    getActiveEnvironmentAgentTask(db, environmentId),
  ]);

  return {
    runtimeReady,
    environment: environment
      ? {
          id: environment.id,
          name: environment.name,
          hasConfiguredPorts: hasConfiguredPreviewPorts(environment.config),
          portNames: (environment.config.ports ?? []).map((port) => port.name),
        }
      : null,
    runHasPreviewDomains,
    setupTask,
  };
}

/**
 * Launch an environment-setup agent focused on getting live previews working
 * for the task's environment. The environment id is derived server-side from
 * the task run, so callers cannot target arbitrary environments. If an agent
 * is already working on the environment, returns that task instead of
 * launching a duplicate.
 */
export async function startPreviewSetupTaskCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
): Promise<{ taskId: string; alreadyRunning: boolean }> {
  const taskRun = await resolveLatestTaskRunForTask(input.taskId);
  const environmentId = getEnvironmentIdFromPayload(taskRun?.payload);

  if (!environmentId) {
    throw new Error(
      'Live preview setup is only available for environment-backed tasks.',
    );
  }

  const environment = await loadDeploymentEnvironment(environmentId);

  if (!environment) {
    throw new Error('Environment not found');
  }

  const repositoryFullNames = environment.config.repositories.map(
    (repository) => repository.repository,
  );

  const prompt = appendEnvironmentDefinitionGuidance(
    buildUpdateEnvironmentDefinitionPrompt({
      environmentId: environment.id,
      environmentName: environment.name,
      repositoryFullNames,
      config: environment.config,
    }),
    ENVIRONMENT_PREVIEW_SETUP_CHANGE_REQUEST,
    'Requested changes from the user:',
  );

  return withEnvironmentVerificationRetryLock(environment.id, async (tx) => {
    const activeTask = await getActiveEnvironmentAgentTask(tx, environment.id);

    if (activeTask) {
      return { taskId: activeTask.taskId, alreadyRunning: true };
    }

    const launchResult = await enqueueTask({
      title: `Set up live previews: ${environment.name}`,
      task: {
        type: TaskPayloadKind.StandardTask,
        payload: {
          ...buildEnvironmentDefinitionWorkspacePayload(repositoryFullNames),
          environmentDefinitionId: environment.id,
          description: prompt,
        },
      },
      initiator: { kind: 'user', userId: auth.userId },
      workflow: 'setup_onboarding',
      surface: 'web',
      trigger: 'manual',
    });

    return { taskId: launchResult.taskId, alreadyRunning: false };
  });
}

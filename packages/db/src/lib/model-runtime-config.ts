import { eq } from 'drizzle-orm';
import {
  applyImplicitLiteLlmModelPrefix,
  CHATGPT_FAST_MODE_ENV_VAR_NAME,
  CHATGPT_OPENCODE_PROVIDER_ID,
  DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  getDefaultTaskModelId,
  getEnabledTaskModels,
  getModelProviderEnvKeyCandidates,
  getTaskModelCatalog,
  INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME,
  INFERENCE_GATEWAY_XAI_ENV_VAR_NAME,
  isConfiguredEnvValue,
  isInferenceGatewayCoveredEnvVar,
  isSettingsOnlyProviderEnvVar,
  normalizeDeploymentModelConfig,
  normalizeOptionalReasoningEffort,
  parseModelProviderEnvKeys,
  ROOMOTE_INFERENCE_API_KEY_ENV_VAR_NAME,
  ROOMOTE_INFERENCE_PROVIDER_ID,
  resolveSetupModelProviderIdFromModel,
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
  TASK_MODEL_CONTEXT_WINDOWS_ENV_VAR_NAME,
  TASK_MODEL_COSTS_ENV_VAR_NAME,
  XAI_OPENCODE_PROVIDER_ID,
  type TaskModelRole,
  type TaskModelOption,
} from '@roomote/types';

import { decryptSecrets } from '../encryption';
import {
  isChatGptSubscriptionFastModeEnabled,
  resolveOpenCodeAuthContent,
} from './chatgpt-subscription';
import { resolveGitHubCopilotOpenCodeAuthContent } from './github-copilot-subscription';
import { getFreshXaiAccessToken } from './xai-subscription';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';
import {
  resolveDeploymentEnvVar,
  stringifyDecryptedEnvVarValue,
} from './environment-variables';

const DEFAULT_DEPLOYMENT_ID = 'default';
const DISABLED_MODEL_PROVIDER_ENV_VAR_NAME_SET = new Set<string>(
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
);

export class DevLoginInferencePlaceholderError extends Error {
  constructor() {
    super(
      'Local development login uses an intentionally invalid inference key. Configure a real inference provider in Settings > Models before running tasks.',
    );
    this.name = 'DevLoginInferencePlaceholderError';
  }
}

function rejectDevLoginInferencePlaceholder(value: string): string {
  if (value === DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER) {
    throw new DevLoginInferencePlaceholderError();
  }

  return value;
}

async function loadPersistedDeploymentEnvVars(
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  const encryptedEnvVars = await executor.query.environmentVariables.findMany();
  const decryptedEnvVars = await Promise.all(
    encryptedEnvVars.map(async ({ name, value }) => ({
      name,
      value: await decryptSecrets<string>(value),
    })),
  );

  return decryptedEnvVars
    .filter(
      (envVar): envVar is { name: string; value: string } =>
        envVar.value !== null,
    )
    .reduce(
      (acc, { name, value }) => {
        acc[name] = stringifyDecryptedEnvVarValue(value);
        return acc;
      },
      {} as Record<string, string>,
    );
}

export async function resolveEffectiveDeploymentEnvVars(
  options: {
    deploymentEnvVars?: Record<string, string>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<Record<string, string>> {
  if (options.deploymentEnvVars) {
    return options.deploymentEnvVars;
  }

  return loadPersistedDeploymentEnvVars(options.executor ?? db);
}

async function loadPersistedRuntimeModelConfig(
  executor: DatabaseOrTransaction = db,
) {
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      runtimeModelConfig: true,
      taskModelSettings: true,
    },
  });

  return {
    runtimeModelConfig: normalizeDeploymentModelConfig(
      deployment?.runtimeModelConfig,
    ),
    catalogModels: getTaskModelCatalog(deployment?.taskModelSettings),
    enabledCatalogModels: getEnabledTaskModels(deployment?.taskModelSettings),
    defaultModelId: getDefaultTaskModelId(deployment?.taskModelSettings),
  };
}

export async function getDeploymentTaskModelOptions(
  executor: DatabaseOrTransaction = db,
): Promise<{ models: TaskModelOption[]; defaultModelId: string }> {
  const { enabledCatalogModels, defaultModelId } =
    await loadPersistedRuntimeModelConfig(executor);
  return { models: enabledCatalogModels, defaultModelId };
}

function normalizeConfiguredValue(
  value: string | null | undefined,
): string | undefined {
  return isConfiguredEnvValue(value) ? value.trim() : undefined;
}

function normalizeConfiguredReasoningEffort(
  value: string | null | undefined,
): string | undefined {
  return (
    normalizeOptionalReasoningEffort(normalizeConfiguredValue(value)) ??
    undefined
  );
}

function resolveProviderKeyNames({
  runtimeRoomoteModelEnvKeys,
  resolvedRoomoteModels,
}: {
  runtimeRoomoteModelEnvKeys?: string;
  resolvedRoomoteModels: Array<string | undefined>;
}): string[] {
  const configuredProviderKeys = parseModelProviderEnvKeys(
    runtimeRoomoteModelEnvKeys,
  ).filter(
    (envVarName) => !DISABLED_MODEL_PROVIDER_ENV_VAR_NAME_SET.has(envVarName),
  );

  if (configuredProviderKeys.length > 0) {
    return configuredProviderKeys;
  }

  const providerIds = resolvedRoomoteModels.flatMap((model) => {
    const providerId = resolveSetupModelProviderIdFromModel(model);

    return providerId ? [providerId] : [];
  });

  return [
    ...new Set(
      providerIds.flatMap((providerId) =>
        getModelProviderEnvKeyCandidates({ providerId }),
      ),
    ),
  ];
}

/**
 * Resolve a single model-provider env value with the same precedence the task
 * runtime uses: the runtime process env first, then the persisted (encrypted)
 * deployment environment variables. Settings-only vars (see
 * `SETTINGS_ONLY_MODEL_PROVIDER_ENV_VAR_NAMES`) are the exception: their env
 * variables are only the hosting platform's delivery mechanism (setup
 * imports them into Settings storage), so they resolve
 * from the persisted store alone — deleting the stored key disables the
 * provider even while hosting keeps injecting the variable.
 */
export async function resolveModelProviderEnvValue(
  envVarNames: string | readonly string[],
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<string | undefined> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const names = typeof envVarNames === 'string' ? [envVarNames] : envVarNames;

  for (const envVarName of names) {
    if (isSettingsOnlyProviderEnvVar(envVarName)) continue;
    const runtimeValue = normalizeConfiguredValue(runtimeEnv[envVarName]);

    if (runtimeValue) {
      return rejectDevLoginInferencePlaceholder(runtimeValue);
    }
  }

  for (const envVarName of names) {
    const persistedValue = await resolveDeploymentEnvVar(
      envVarName,
      options.executor ?? db,
      {},
    );

    const normalizedValue = normalizeConfiguredValue(persistedValue);

    if (normalizedValue) {
      return rejectDevLoginInferencePlaceholder(normalizedValue);
    }
  }

  return undefined;
}

/**
 * The R_BRAIN_* names alone, in Settings or the environment, are the Brain's
 * activation signal. The general provider keys (OPENROUTER_API_KEY,
 * OPENAI_API_KEY) exist on nearly every deployment because they run tasks,
 * and some platform templates auto-generate the Brain's gateway token and
 * URL as plumbing, so none of those can carry an operator's intent to turn
 * the Brain on. Setting a brain-specific key is the one signal that cannot
 * happen by accident.
 */
const EXPLICIT_BRAIN_PROVIDER_ENV_VAR_NAMES = [
  'R_BRAIN_OPENROUTER_API_KEY',
  'R_BRAIN_OPENAI_API_KEY',
] as const;

/**
 * Cached like the Brain provider resolution in @roomote/sdk and for the same
 * reason: this predicate sits in front of per-event paths (sandbox MCP
 * delivery, fast-agent integration listing) and per-minute scheduled jobs,
 * and the answer only changes when an admin edits Settings.
 */
const BRAIN_PROVIDER_CONFIGURED_CACHE_TTL_MS = 30_000;

let brainProviderConfiguredCache: {
  value: boolean;
  expiresAtMs: number;
} | null = null;

/** Drop the cached answer, so the next call re-reads settings. */
export function resetBrainProviderConfiguredCache(): void {
  brainProviderConfiguredCache = null;
}

/**
 * Whether an operator explicitly enabled the Brain by configuring a
 * brain-specific provider key.
 *
 * This is the legacy activation signal, kept as the fallback inside
 * `resolveBrainEnabledState` for deployments that opted in before the
 * `brainEnabled` Settings toggle existed. New code gates on `isBrainEnabled`.
 * It is deliberately narrower than the Brain's inference-provider resolution,
 * whose general-key fallback exists so an already-enabled Brain can bill
 * through the deployment's regular provider key; counting that fallback (or
 * template-generated plumbing) as activation would turn the Brain on for
 * deployments that never asked for one.
 */
export async function isBrainProviderConfigured(): Promise<boolean> {
  const cached = brainProviderConfiguredCache;

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.value;
  }

  const value = Boolean(
    (
      await resolveModelProviderEnvValue(EXPLICIT_BRAIN_PROVIDER_ENV_VAR_NAMES)
    )?.trim(),
  );

  brainProviderConfiguredCache = {
    value,
    expiresAtMs: Date.now() + BRAIN_PROVIDER_CONFIGURED_CACHE_TTL_MS,
  };

  return value;
}

export type BrainEnabledState = {
  enabled: boolean;
  /**
   * True when no explicit choice is stored and the legacy activation signal
   * (an explicit R_BRAIN_* provider key) decided the answer.
   */
  fromLegacyKey: boolean;
};

let brainEnabledCache: {
  value: BrainEnabledState;
  expiresAtMs: number;
} | null = null;

/** Drop the cached answer, so the next call re-reads settings. */
export function invalidateBrainEnabledCache(): void {
  brainEnabledCache = null;
}

/**
 * Whether the Brain is on for this deployment, with its provenance. This is
 * the activation predicate for everything user-visible: delivering the gbrain
 * MCP server to sandboxes, listing the Brain as a fast-agent integration,
 * resolving Brain connections, and accepting task memories.
 *
 * The stored Settings toggle wins when set (either way). A null/missing value
 * falls back to `isBrainProviderConfigured()` so deployments that opted in
 * with an explicit R_BRAIN_* key before the toggle existed stay enabled
 * without a backfill. Cached like the legacy predicate and for the same
 * reason: it fronts per-event paths, and the answer only changes when an
 * admin edits Settings.
 */
export async function resolveBrainEnabledState(): Promise<BrainEnabledState> {
  const cached = brainEnabledCache;

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.value;
  }

  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { brainEnabled: true },
  });
  const stored = deployment?.brainEnabled ?? null;
  const value: BrainEnabledState =
    stored === null
      ? { enabled: await isBrainProviderConfigured(), fromLegacyKey: true }
      : { enabled: stored, fromLegacyKey: false };

  brainEnabledCache = {
    value,
    expiresAtMs: Date.now() + BRAIN_PROVIDER_CONFIGURED_CACHE_TTL_MS,
  };

  return value;
}

export async function isBrainEnabled(): Promise<boolean> {
  return (await resolveBrainEnabledState()).enabled;
}

/** Persist an explicit Brain on/off choice and drop the cached answer. */
export async function setBrainEnabled(value: boolean): Promise<void> {
  const now = new Date();

  await db
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, brainEnabled: value, updatedAt: now })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: { brainEnabled: value, updatedAt: now },
    });

  invalidateBrainEnabledCache();
}

type ModelRuntimeEnvOptions = {
  runtimeEnv?: Partial<Record<string, string | undefined>>;
  deploymentEnvVars?: Record<string, string>;
  executor?: DatabaseOrTransaction;
};

/**
 * Resolve model runtime env for control-plane inference (routing, titles,
 * summaries): raw provider keys are returned because control-plane calls
 * hold no run token to present to the inference gateway.
 */
export async function resolveEffectiveModelRuntimeEnv(
  options: ModelRuntimeEnvOptions = {},
): Promise<Record<string, string>> {
  return resolveModelRuntimeEnv(options, { inferenceGateway: false });
}

/**
 * Resolve model runtime env for a task sandbox: the configured provider keys
 * the inference gateway can serve stay on the control plane and their names
 * are advertised via `R_INFERENCE_GATEWAY_KEYS` instead. Connected ChatGPT,
 * GitHub Copilot, and xAI Grok subscriptions are routed through the gateway
 * via markers rather than materializing OAuth credentials in the sandbox.
 */
export async function resolveSandboxModelRuntimeEnv(
  options: ModelRuntimeEnvOptions = {},
): Promise<Record<string, string>> {
  return resolveModelRuntimeEnv(options, { inferenceGateway: true });
}

async function resolveModelRuntimeEnv(
  options: ModelRuntimeEnvOptions,
  { inferenceGateway }: { inferenceGateway: boolean },
): Promise<Record<string, string>> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const [
    persistedEnvVars,
    { runtimeModelConfig, catalogModels, enabledCatalogModels, defaultModelId },
  ] = await Promise.all([
    resolveEffectiveDeploymentEnvVars({
      deploymentEnvVars: options.deploymentEnvVars,
      executor,
    }),
    loadPersistedRuntimeModelConfig(executor),
  ]);
  const persistedRuntimeModelConfig = runtimeModelConfig;
  const runtimeOverrideModelConfig = normalizeDeploymentModelConfig(
    Object.fromEntries(
      TASK_MODEL_ROLES.map((role) => {
        const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
        return [descriptor.modelConfigKey, runtimeEnv[descriptor.modelEnvVar]];
      }),
    ),
  );
  // Bare R_MODEL values are valid LiteLLM route names when a LiteLLM endpoint
  // is configured; rewrite them to OpenCode's litellm/<name> form before key
  // resolution so provider credentials and sandbox validation stay aligned.
  const isLiteLlmConfigured = Boolean(
    normalizeConfiguredValue(runtimeEnv.LITELLM_BASE_URL) ??
    normalizeConfiguredValue(persistedEnvVars.LITELLM_BASE_URL),
  );
  const withLiteLlmPrefix = (modelId: string | undefined): string | undefined =>
    modelId
      ? applyImplicitLiteLlmModelPrefix(modelId, isLiteLlmConfigured)
      : undefined;
  const resolvedModels = Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => {
      const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
      return [
        role,
        withLiteLlmPrefix(
          runtimeOverrideModelConfig[descriptor.modelConfigKey] ??
            normalizeConfiguredValue(
              persistedRuntimeModelConfig[descriptor.modelConfigKey],
            ) ??
            (descriptor.modelFallback === 'deployment-default'
              ? defaultModelId
              : undefined),
        ),
      ];
    }),
  ) as Record<TaskModelRole, string | undefined>;
  // Roomote applies per-role reasoning defaults when no explicit level is
  // configured, but only for models that are not known to lack configurable
  // reasoning support (unknown support keeps the default, matching the UI).
  const modelSupportsReasoning = (modelId: string | undefined): boolean => {
    if (!modelId) {
      return false;
    }

    const catalogModel: TaskModelOption | undefined = catalogModels.find(
      (model) => model.id === modelId,
    );

    return catalogModel?.metadata?.supportsReasoning !== false;
  };
  const resolvedReasoningEfforts = Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => {
      const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
      const reasoningModel =
        descriptor.reasoningModelFallback === 'coding'
          ? (resolvedModels[role] ?? resolvedModels.coding)
          : resolvedModels[role];

      return [
        role,
        normalizeConfiguredReasoningEffort(
          runtimeEnv[descriptor.reasoningEnvVar],
        ) ??
          persistedRuntimeModelConfig[descriptor.reasoningConfigKey] ??
          (modelSupportsReasoning(reasoningModel)
            ? descriptor.defaultReasoningEffort
            : undefined),
      ];
    }),
  ) as Record<TaskModelRole, string | undefined>;
  const configuredRoomoteModelEnvKeys =
    normalizeConfiguredValue(runtimeEnv.R_MODEL_ENV_KEYS) ??
    normalizeConfiguredValue(persistedEnvVars.R_MODEL_ENV_KEYS);
  const resolvedRoleModels = [
    ...TASK_MODEL_ROLES.filter(
      (role) =>
        !inferenceGateway || TASK_MODEL_ROLE_DESCRIPTORS[role].includeInSandbox,
    ).map((role) => resolvedModels[role]),
  ];
  const providerKeyNames = resolveProviderKeyNames({
    runtimeRoomoteModelEnvKeys: configuredRoomoteModelEnvKeys,
    resolvedRoomoteModels: resolvedRoleModels,
  });
  // A running OpenCode task can switch to any enabled catalog model without
  // another dequeue, while configured role agents can select their own
  // providers. Gateway coverage must therefore include both sets up front;
  // otherwise a later model switch either sees a missing key or uses a raw
  // provider credential that was already written into the sandbox.
  const gatewaySwitchableModelIds = inferenceGateway
    ? enabledCatalogModels.map((model) => model.id)
    : [];
  const taskModelContextWindows = inferenceGateway
    ? Object.fromEntries(
        enabledCatalogModels.flatMap((model) => {
          const contextWindow = model.metadata?.contextWindow;

          return typeof contextWindow === 'number' &&
            Number.isSafeInteger(contextWindow) &&
            contextWindow > 0
            ? [[model.id, contextWindow]]
            : [];
        }),
      )
    : {};
  // Per-model pricing for the generated OpenCode config, in USD per million
  // tokens. Custom providers (Roomote inference included) are invisible to
  // OpenCode's own models.dev pricing, so without this every message on them
  // records zero cost in the task usage ledger.
  const taskModelCosts = inferenceGateway
    ? Object.fromEntries(
        enabledCatalogModels.flatMap((model) => {
          const inputPricePerToken = model.metadata?.inputPricePerToken;
          const outputPricePerToken = model.metadata?.outputPricePerToken;

          return typeof inputPricePerToken === 'number' &&
            Number.isFinite(inputPricePerToken) &&
            inputPricePerToken >= 0 &&
            typeof outputPricePerToken === 'number' &&
            Number.isFinite(outputPricePerToken) &&
            outputPricePerToken >= 0
            ? [
                [
                  model.id,
                  {
                    input: inputPricePerToken * 1_000_000,
                    output: outputPricePerToken * 1_000_000,
                  },
                ],
              ]
            : [];
        }),
      )
    : {};
  const gatewayProviderKeyNames = [
    ...new Set([
      ...providerKeyNames,
      ...resolveProviderKeyNames({
        resolvedRoomoteModels: gatewaySwitchableModelIds,
      }),
    ]),
  ];
  const managedRoomoteInferenceSelected = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      resolveSetupModelProviderIdFromModel(modelId) ===
      ROOMOTE_INFERENCE_PROVIDER_ID,
  );
  // When the gateway is active, the configured provider keys it can serve
  // (OpenRouter, Anthropic, OpenAI, Gemini, the aggregators, Bedrock) stay on
  // the control plane and are advertised to the worker by name via
  // R_INFERENCE_GATEWAY_KEYS; the worker builds the (container-reachable)
  // gateway URL from its own platform URL and rebases exactly these providers.
  // Only configured keys are withheld; credentials for disabled providers are
  // filtered before this point and never flow to the task runtime.
  const gatewayServedKeyNames = inferenceGateway
    ? gatewayProviderKeyNames.filter(
        (name) =>
          isInferenceGatewayCoveredEnvVar(name) &&
          ((name === ROOMOTE_INFERENCE_API_KEY_ENV_VAR_NAME &&
            managedRoomoteInferenceSelected) ||
            normalizeConfiguredValue(runtimeEnv[name]) !== undefined ||
            normalizeConfiguredValue(persistedEnvVars[name]) !== undefined),
      )
    : [];
  const gatewayServedKeyNameSet = new Set(gatewayServedKeyNames);

  const resolvedProviderKeyValues = Object.fromEntries(
    providerKeyNames.flatMap((envVarName) => {
      if (gatewayServedKeyNameSet.has(envVarName)) {
        return [];
      }

      const value =
        (isSettingsOnlyProviderEnvVar(envVarName)
          ? undefined
          : normalizeConfiguredValue(runtimeEnv[envVarName])) ??
        normalizeConfiguredValue(persistedEnvVars[envVarName]);

      return value
        ? [[envVarName, rejectDevLoginInferencePlaceholder(value)]]
        : [];
    }),
  );

  // ChatGPT subscription coverage: when a connected subscription exists and
  // any resolved role or gateway-switchable model uses the `openai/` prefix,
  // inject the OAuth record as `OPENCODE_AUTH_CONTENT`. opencode's Codex
  // plugin prefers OAuth auth when present, so the subscription wins over
  // `OPENAI_API_KEY` at runtime even when both are configured. This single
  // choke point covers both task launches (dequeue-helpers) and
  // routing/title/summary calls (non-task-provider-usage).
  //
  // In sandbox gateway mode the OAuth record must stay on the control plane,
  // so instead of shipping OPENCODE_AUTH_CONTENT the resolver emits the
  // R_INFERENCE_GATEWAY_CHATGPT marker; the worker rebases the `openai`
  // provider onto the gateway, which mints and injects the access token.
  const usesOpenAiModel = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      typeof modelId === 'string' &&
      modelId.startsWith(`${CHATGPT_OPENCODE_PROVIDER_ID}/`),
  );
  const injectedOpenCodeAuthContent = usesOpenAiModel
    ? await resolveOpenCodeAuthContent({ executor })
    : null;
  const routeChatGptThroughGateway =
    inferenceGateway && injectedOpenCodeAuthContent != null;
  const chatGptFastMode = injectedOpenCodeAuthContent
    ? await isChatGptSubscriptionFastModeEnabled(executor)
    : false;
  const usesGitHubCopilotModel = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      typeof modelId === 'string' && modelId.startsWith('github-copilot/'),
  );
  const githubCopilotAuthContent = usesGitHubCopilotModel
    ? await resolveGitHubCopilotOpenCodeAuthContent(executor)
    : null;
  const routeGitHubCopilotThroughGateway =
    inferenceGateway && githubCopilotAuthContent != null;
  // xAI Grok subscription: when a connected OAuth record exists and any role
  // or switchable model uses `xai/`, route through the gateway (marker only)
  // or mint a fresh access token for non-gateway control-plane use.
  const usesXaiModel = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      typeof modelId === 'string' &&
      modelId.startsWith(`${XAI_OPENCODE_PROVIDER_ID}/`),
  );
  const xaiAccessToken = usesXaiModel
    ? await getFreshXaiAccessToken({ executor })
    : null;
  const routeXaiThroughGateway = inferenceGateway && xaiAccessToken != null;
  // OpenCode's xAI provider is API-key shaped, not oauth Auth.Info. For
  // non-gateway control-plane inference (titles, summaries, routing), mint a
  // fresh access token and inject it as XAI_API_KEY. Never put the refresh
  // token into OpenCode env. Prefer a connected subscription over BYOK so
  // control-plane and gateway dual-path use the same credential precedence.
  const xaiApiKeyFromOAuth: Record<string, string> =
    xaiAccessToken && !routeXaiThroughGateway
      ? { XAI_API_KEY: xaiAccessToken.access }
      : {};
  const directOpenCodeAuthContent = [
    injectedOpenCodeAuthContent,
    githubCopilotAuthContent,
  ].reduce<Record<string, unknown>>((merged, content) => {
    return content ? { ...merged, ...JSON.parse(content) } : merged;
  }, {});

  // When only the subscription is connected (no XAI_API_KEY), still advertise
  // the provider key name so the worker knows xai models are gateway-covered.
  // The marker alone drives rebase; R_INFERENCE_GATEWAY_KEYS stays key-based.
  const xaiKeyAlreadyServed = gatewayServedKeyNameSet.has('XAI_API_KEY');
  const effectiveGatewayServedKeyNames =
    routeXaiThroughGateway && !xaiKeyAlreadyServed
      ? [...gatewayServedKeyNames, 'XAI_API_KEY']
      : gatewayServedKeyNames;

  const resolvedRoleEnv = Object.fromEntries(
    TASK_MODEL_ROLES.flatMap((role) => {
      const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
      if (inferenceGateway && !descriptor.includeInSandbox) {
        return [];
      }

      return [
        ...(resolvedModels[role]
          ? [[descriptor.modelEnvVar, resolvedModels[role]]]
          : []),
        ...(resolvedReasoningEfforts[role]
          ? [[descriptor.reasoningEnvVar, resolvedReasoningEfforts[role]]]
          : []),
      ];
    }),
  );

  return {
    ...resolvedRoleEnv,
    ...(providerKeyNames.length > 0 && {
      R_MODEL_ENV_KEYS: providerKeyNames.join(','),
    }),
    ...resolvedProviderKeyValues,
    ...xaiApiKeyFromOAuth,
    ...(effectiveGatewayServedKeyNames.length > 0 && {
      [INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME]:
        effectiveGatewayServedKeyNames.join(','),
    }),
    ...(Object.keys(taskModelContextWindows).length > 0 && {
      [TASK_MODEL_CONTEXT_WINDOWS_ENV_VAR_NAME]: JSON.stringify(
        taskModelContextWindows,
      ),
    }),
    ...(Object.keys(taskModelCosts).length > 0 && {
      [TASK_MODEL_COSTS_ENV_VAR_NAME]: JSON.stringify(taskModelCosts),
    }),
    ...(routeChatGptThroughGateway
      ? { [INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME]: '1' }
      : {}),
    ...(chatGptFastMode ? { [CHATGPT_FAST_MODE_ENV_VAR_NAME]: '1' } : {}),
    ...(routeGitHubCopilotThroughGateway
      ? { [INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME]: '1' }
      : {}),
    ...(routeXaiThroughGateway
      ? { [INFERENCE_GATEWAY_XAI_ENV_VAR_NAME]: '1' }
      : {}),
    ...(!routeChatGptThroughGateway &&
    !routeGitHubCopilotThroughGateway &&
    Object.keys(directOpenCodeAuthContent).length > 0
      ? { OPENCODE_AUTH_CONTENT: JSON.stringify(directOpenCodeAuthContent) }
      : {}),
  };
}

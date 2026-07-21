import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  getDefaultAvailableComputeProvider,
  getSetupComputeProvider,
  pickPreferredConfiguredComputeProvider,
  SETUP_COMPUTE_PROVIDER_CATALOG,
  SHARED_WORKER_IMAGE_ENV_VAR,
  deriveModalBaseImageRefDefault,
  resolveEffectiveDockerWorkerImage,
  resolveDerivedModalBaseImageRef,
  isRequiredComputeField,
  isComputeProvider,
  normalizeDeploymentComputeConfig,
  parseExcludedComputeProviders,
  type ComputeProvider,
} from '@roomote/types';

import { decryptSecrets } from '../encryption';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings, environmentVariables } from '../schema';
import { stringifyDecryptedEnvVarValue } from './environment-variables';

const DEFAULT_DEPLOYMENT_ID = 'default';

type ComputeRuntimeEnv = Partial<Record<string, unknown>>;

function normalizeComputeRuntimeEnvValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value.trim() || undefined;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return undefined;
  }
}

async function loadPersistedRuntimeComputeConfig(
  executor: DatabaseOrTransaction = db,
) {
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      runtimeComputeConfig: true,
    },
  });

  return normalizeDeploymentComputeConfig(deployment?.runtimeComputeConfig);
}

async function isComputeProviderConfigured(
  provider: ComputeProvider,
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<boolean> {
  const resolvedEnvValues = await resolveComputeProviderEnvValues(provider, {
    runtimeEnv: options.runtimeEnv,
    executor: options.executor,
  });
  const requiredEnvVarNames = getSetupComputeProvider(provider)
    .fields.filter(isRequiredComputeField)
    .map((field) => field.envVarName);

  return requiredEnvVarNames.every((envVarName) =>
    Boolean(resolvedEnvValues[envVarName]?.trim()),
  );
}

type PersistedRuntimeComputeConfig = Awaited<
  ReturnType<typeof loadPersistedRuntimeComputeConfig>
>;

function getExcludedComputeProviders(
  runtimeEnv: Partial<Record<string, string | undefined>>,
  persistedComputeConfig: PersistedRuntimeComputeConfig,
) {
  const excludedProviders = parseExcludedComputeProviders(
    runtimeEnv.EXCLUDED_COMPUTE_PROVIDERS,
  );

  for (const provider of persistedComputeConfig.excludedProviders) {
    excludedProviders.add(provider);
  }

  return excludedProviders;
}

async function listConfiguredComputeProvidersFromState({
  runtimeEnv,
  executor,
  excludedProviders,
}: {
  runtimeEnv: Partial<Record<string, string | undefined>>;
  executor: DatabaseOrTransaction;
  excludedProviders: ReadonlySet<ComputeProvider>;
}): Promise<ComputeProvider[]> {
  const providerChecks = await Promise.all(
    SETUP_COMPUTE_PROVIDER_CATALOG.map(async ({ provider }) => {
      if (excludedProviders.has(provider)) {
        return null;
      }

      return (await isComputeProviderConfigured(provider, {
        runtimeEnv,
        executor,
      }))
        ? provider
        : null;
    }),
  );

  return providerChecks.filter(
    (provider): provider is ComputeProvider => provider !== null,
  );
}

function pickDefaultComputeProvider({
  runtimeEnv,
  persistedComputeConfig,
  excludedProviders,
  configuredProviders,
}: {
  runtimeEnv: Partial<Record<string, string | undefined>>;
  persistedComputeConfig: PersistedRuntimeComputeConfig;
  excludedProviders: ReadonlySet<ComputeProvider>;
  configuredProviders: readonly ComputeProvider[];
}): ComputeProvider {
  if (
    persistedComputeConfig.defaultProvider &&
    !excludedProviders.has(persistedComputeConfig.defaultProvider)
  ) {
    return persistedComputeConfig.defaultProvider;
  }

  const runtimeDefault = runtimeEnv.DEFAULT_COMPUTE_PROVIDER?.trim();
  if (
    runtimeDefault &&
    isComputeProvider(runtimeDefault) &&
    !excludedProviders.has(runtimeDefault) &&
    runtimeDefault !== 'docker'
  ) {
    return runtimeDefault;
  }

  const preferredConfigured =
    pickPreferredConfiguredComputeProvider(configuredProviders);

  if (
    runtimeDefault === 'docker' &&
    isComputeProvider(runtimeDefault) &&
    !excludedProviders.has(runtimeDefault)
  ) {
    return preferredConfigured && preferredConfigured !== 'docker'
      ? preferredConfigured
      : 'docker';
  }

  return (
    preferredConfigured ?? getDefaultAvailableComputeProvider(excludedProviders)
  );
}

/**
 * Lists sandbox providers that are both not excluded and fully configured for
 * task launch. Used by surfaces that let users pick a compute backend.
 */
export async function listConfiguredComputeProviders(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<ComputeProvider[]> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const persistedComputeConfig = executor.query?.deploymentSettings
    ? await loadPersistedRuntimeComputeConfig(executor)
    : { defaultProvider: null, excludedProviders: [] };
  const excludedProviders = getExcludedComputeProviders(
    runtimeEnv,
    persistedComputeConfig,
  );

  // Promise.all keeps independent provider checks to one latency window while
  // map/filter preserve setup-catalog display order.
  return listConfiguredComputeProvidersFromState({
    runtimeEnv,
    executor,
    excludedProviders,
  });
}

/**
 * Resolves both values needed by provider pickers with one deployment-settings
 * read and one parallel readiness scan.
 */
export async function resolveComputeProviderSelection(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<{
  defaultComputeProvider: ComputeProvider;
  availableComputeProviders: ComputeProvider[];
}> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const persistedComputeConfig =
    await loadPersistedRuntimeComputeConfig(executor);
  const excludedProviders = getExcludedComputeProviders(
    runtimeEnv,
    persistedComputeConfig,
  );
  const availableComputeProviders =
    await listConfiguredComputeProvidersFromState({
      runtimeEnv,
      executor,
      excludedProviders,
    });

  return {
    defaultComputeProvider: pickDefaultComputeProvider({
      runtimeEnv,
      persistedComputeConfig,
      excludedProviders,
      configuredProviders: availableComputeProviders,
    }),
    availableComputeProviders,
  };
}

/**
 * Resolves the deployment default compute provider. Order of preference:
 * 1. Persisted setup/admin default (explicit deployment choice).
 * 2. DEFAULT_COMPUTE_PROVIDER env when it is a non-docker provider (direct
 *    return — no catalog readiness scan on hot dispatch paths).
 * 3. When the env default is docker or unset: scan configured providers and
 *    prefer the last catalog-ordered configured cloud over Local Docker.
 *    Compose stacks often inject DEFAULT_COMPUTE_PROVIDER=docker; a ready
 *    cloud provider outranks that barrier default.
 * 4. Local Docker / remaining availability fallback.
 */
export async function resolveDefaultComputeProvider(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<ComputeProvider> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const persistedComputeConfig =
    await loadPersistedRuntimeComputeConfig(executor);
  const excludedProviders = getExcludedComputeProviders(
    runtimeEnv,
    persistedComputeConfig,
  );

  if (
    persistedComputeConfig.defaultProvider &&
    !excludedProviders.has(persistedComputeConfig.defaultProvider)
  ) {
    return persistedComputeConfig.defaultProvider;
  }

  const runtimeDefault = runtimeEnv.DEFAULT_COMPUTE_PROVIDER?.trim();
  if (
    runtimeDefault &&
    isComputeProvider(runtimeDefault) &&
    !excludedProviders.has(runtimeDefault) &&
    runtimeDefault !== 'docker'
  ) {
    // Authoritative non-Docker env defaults skip the catalog readiness scan
    // used by enqueue/retry/dequeue paths.
    return runtimeDefault;
  }

  // Docker env default or unset: resolve cloud-vs-Local Docker from readiness.
  const configuredProviders = await listConfiguredComputeProvidersFromState({
    runtimeEnv,
    executor,
    excludedProviders,
  });

  return pickDefaultComputeProvider({
    runtimeEnv,
    persistedComputeConfig,
    excludedProviders,
    configuredProviders,
  });
}

/**
 * Resolves the setup-catalog env values for one compute provider, preferring
 * the process env and falling back to encrypted deployment environment
 * variables saved during setup. For Modal, an explicit process-level base
 * image wins; otherwise the deployment's current worker image (the explicit
 * DOCKER_WORKER_IMAGE or the ref derived from the baked RELEASE_VERSION)
 * outranks a saved base image so upgrades cannot remain pinned to an older
 * auto-derived worker image. Development finally falls back to the public
 * GHCR channel image. The published worker image doubles as the Modal base
 * image.
 */
export async function resolveComputeProviderEnvValues(
  provider: ComputeProvider,
  options: {
    runtimeEnv?: ComputeRuntimeEnv;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<Partial<Record<string, string>>> {
  const rawRuntimeEnv = options.runtimeEnv ?? process.env;
  const runtimeEnv = Object.fromEntries(
    Object.entries(rawRuntimeEnv).flatMap(([name, value]) => {
      const normalized = normalizeComputeRuntimeEnvValue(value);
      return normalized === undefined ? [] : [[name, normalized]];
    }),
  );
  const executor = options.executor ?? db;
  const descriptor = getSetupComputeProvider(provider);
  const envVarNames = descriptor.fields.map((field) => field.envVarName);

  if (envVarNames.length === 0) {
    return {};
  }

  const resolvedValues: Partial<Record<string, string>> = {};
  const missingEnvVarNames: string[] = [];

  const effectiveRuntimeWorkerImage =
    resolveEffectiveDockerWorkerImage(runtimeEnv) ?? undefined;
  const usesModalBaseImage = provider === 'modal' || provider === 'roomote';
  const runtimeManagedModalBaseImage =
    usesModalBaseImage && !runtimeEnv.MODAL_BASE_IMAGE_REF
      ? deriveModalBaseImageRefDefault(effectiveRuntimeWorkerImage)
      : null;

  if (runtimeManagedModalBaseImage) {
    resolvedValues.MODAL_BASE_IMAGE_REF = runtimeManagedModalBaseImage;
  }

  for (const envVarName of envVarNames) {
    const runtimeValue = runtimeEnv[envVarName];

    if (runtimeValue) {
      resolvedValues[envVarName] = runtimeValue;
    } else if (resolvedValues[envVarName]) {
      continue;
    } else {
      missingEnvVarNames.push(envVarName);
    }
  }

  if (missingEnvVarNames.length > 0) {
    const missingEnvVarNameSet = new Set(missingEnvVarNames);
    const encryptedEnvVars = await executor
      .select({
        name: environmentVariables.name,
        value: environmentVariables.value,
      })
      .from(environmentVariables)
      .where(inArray(environmentVariables.name, missingEnvVarNames));

    for (const envVar of encryptedEnvVars) {
      if (!missingEnvVarNameSet.has(envVar.name)) {
        continue;
      }

      const decryptedValue = await decryptSecrets<string>(envVar.value);

      if (decryptedValue === null) {
        continue;
      }

      const value = stringifyDecryptedEnvVarValue(decryptedValue).trim();

      if (value) {
        resolvedValues[envVar.name] = value;
      }
    }
  }

  // Effective worker image is deploy/runtime-managed only: process env
  // DOCKER_WORKER_IMAGE, then the ref derived from the baked RELEASE_VERSION.
  // Legacy deployment-env rows from the removed Settings worker-image UI are
  // intentionally ignored so a sticky saved value cannot pin release-derived
  // workers back to a stale image. Development falls back to the public
  // latest image when no hosted image is derivable.
  if (usesModalBaseImage && !resolvedValues.MODAL_BASE_IMAGE_REF) {
    const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
      ...runtimeEnv,
      DOCKER_WORKER_IMAGE: effectiveRuntimeWorkerImage,
    });

    if (derivedBaseImageRef) {
      resolvedValues.MODAL_BASE_IMAGE_REF = derivedBaseImageRef;
    }
  }

  return resolvedValues;
}

/**
 * @deprecated Shared worker images are no longer stored via Settings. Returns
 * null so callers drop the old DB-backed middle layer in favor of process env
 * + release-image derivation.
 */
export async function resolveSavedWorkerImage(
  _executor: DatabaseOrTransaction = db,
): Promise<string | null> {
  return null;
}

/**
 * Deletes any deployment-scoped `DOCKER_WORKER_IMAGE` rows left from the
 * removed Settings worker-image editor so they cannot linger as reserved,
 * hidden, sticky configuration.
 */
export async function purgeSavedDeploymentWorkerImage(
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await executor
    .delete(environmentVariables)
    .where(
      and(
        isNull(environmentVariables.userId),
        eq(environmentVariables.name, SHARED_WORKER_IMAGE_ENV_VAR),
      ),
    );
}

import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  getDefaultAvailableComputeProvider,
  getSetupComputeProvider,
  SETUP_COMPUTE_PROVIDER_CATALOG,
  SETUP_COMPUTE_PROVIDER_IDS,
  SHARED_WORKER_IMAGE_ENV_VAR,
  resolveDerivedModalBaseImageRef,
  deriveWorkerImageFromReleaseVersion,
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
  const excludedProviders = parseExcludedComputeProviders(
    runtimeEnv.EXCLUDED_COMPUTE_PROVIDERS,
  );

  // Preserve setup-catalog display order so callers that fall back to the first
  // entry match the home dropdown ordering (modal, e2b, daytona, docker).
  const providers: ComputeProvider[] = [];

  for (const { provider } of SETUP_COMPUTE_PROVIDER_CATALOG) {
    if (excludedProviders.has(provider)) {
      continue;
    }

    if (
      await isComputeProviderConfigured(provider, {
        runtimeEnv,
        executor,
      })
    ) {
      providers.push(provider);
    }
  }

  return providers;
}

/**
 * Resolves the deployment default compute provider. The persisted setup
 * choice wins over the DEFAULT_COMPUTE_PROVIDER env value because compose and
 * PM2 stacks always inject an env default; the admin's explicit setup choice
 * is the stronger signal.
 */
export async function resolveDefaultComputeProvider(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<ComputeProvider> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const persistedComputeConfig = await loadPersistedRuntimeComputeConfig(
    options.executor ?? db,
  );

  if (persistedComputeConfig.defaultProvider) {
    return persistedComputeConfig.defaultProvider;
  }

  const runtimeDefault = runtimeEnv.DEFAULT_COMPUTE_PROVIDER?.trim();
  const excludedProviders = parseExcludedComputeProviders(
    runtimeEnv.EXCLUDED_COMPUTE_PROVIDERS,
  );

  if (
    runtimeDefault &&
    isComputeProvider(runtimeDefault) &&
    !excludedProviders.has(runtimeDefault)
  ) {
    return runtimeDefault;
  }

  const availableProviders = await Promise.all(
    SETUP_COMPUTE_PROVIDER_IDS.filter(
      (provider) => !excludedProviders.has(provider),
    )
      .filter((provider) => provider !== 'docker')
      .map(async (provider) => ({
        provider,
        configSatisfied: await isComputeProviderConfigured(provider, {
          runtimeEnv,
          executor: options.executor ?? db,
        }),
      })),
  );

  return getDefaultAvailableComputeProvider(
    excludedProviders,
    availableProviders,
  );
}

/**
 * Resolves the setup-catalog env values for one compute provider, preferring
 * the process env and falling back to encrypted deployment environment
 * variables saved during setup. For Modal, a still-missing base image ref
 * falls back to the deployment's effective worker image (the explicit
 * DOCKER_WORKER_IMAGE or the ref derived from the baked RELEASE_VERSION),
 * then the development-only GHCR latest image. The published worker image
 * doubles as the Modal base image.
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

  for (const envVarName of envVarNames) {
    const runtimeValue = runtimeEnv[envVarName];

    if (runtimeValue) {
      resolvedValues[envVarName] = runtimeValue;
    } else {
      missingEnvVarNames.push(envVarName);
    }
  }

  if (missingEnvVarNames.length > 0) {
    const encryptedEnvVars = await executor
      .select({
        name: environmentVariables.name,
        value: environmentVariables.value,
      })
      .from(environmentVariables)
      .where(inArray(environmentVariables.name, missingEnvVarNames));

    for (const envVar of encryptedEnvVars) {
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
  if (provider === 'modal' && !resolvedValues.MODAL_BASE_IMAGE_REF) {
    const effectiveWorkerImage =
      runtimeEnv.DOCKER_WORKER_IMAGE?.trim() ||
      deriveWorkerImageFromReleaseVersion(runtimeEnv) ||
      undefined;
    const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
      ...runtimeEnv,
      DOCKER_WORKER_IMAGE: effectiveWorkerImage,
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

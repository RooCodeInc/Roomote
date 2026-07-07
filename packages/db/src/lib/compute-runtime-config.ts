import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  getDefaultAvailableComputeProvider,
  getSetupComputeProvider,
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
      .map(async (provider) => {
        const resolvedEnvValues = await resolveComputeProviderEnvValues(
          provider,
          {
            runtimeEnv,
            executor: options.executor ?? db,
          },
        );
        const requiredEnvVarNames = getSetupComputeProvider(provider)
          .fields.filter(isRequiredComputeField)
          .map((field) => field.envVarName);

        return {
          provider,
          configSatisfied: requiredEnvVarNames.every((envVarName) =>
            resolvedEnvValues[envVarName]?.trim(),
          ),
        };
      }),
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
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<Partial<Record<string, string>>> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const descriptor = getSetupComputeProvider(provider);
  const envVarNames = descriptor.fields.map((field) => field.envVarName);

  if (envVarNames.length === 0) {
    return {};
  }

  const resolvedValues: Partial<Record<string, string>> = {};
  const missingEnvVarNames: string[] = [];

  for (const envVarName of envVarNames) {
    const runtimeValue = runtimeEnv[envVarName]?.trim();

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

  // Derived last so both the runtime env and operator-saved deployment env
  // vars win over the default. The effective worker image follows the runtime
  // precedence: an explicit process-env DOCKER_WORKER_IMAGE wins, then the
  // deployment env var saved through the Settings → Compute shared section,
  // then the ref derived from the baked RELEASE_VERSION. Development falls
  // back to the public latest image when no hosted image is derivable.
  // Honoring the saved worker image here keeps Modal spawnable regardless of
  // the order in which credentials and the shared worker image were saved.
  if (provider === 'modal' && !resolvedValues.MODAL_BASE_IMAGE_REF) {
    const effectiveWorkerImage =
      runtimeEnv.DOCKER_WORKER_IMAGE?.trim() ||
      (await resolveSavedWorkerImage(executor)) ||
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
 * Reads the saved deployment `DOCKER_WORKER_IMAGE` value (the shared hosted
 * compute worker image) from the encrypted deployment env vars. Returns null
 * when no deployment-scoped value is saved. Used so a worker image configured
 * through the UI counts toward hosted readiness before the process restarts.
 */
export async function resolveSavedWorkerImage(
  executor: DatabaseOrTransaction = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ value: environmentVariables.value })
    .from(environmentVariables)
    .where(
      and(
        isNull(environmentVariables.userId),
        eq(environmentVariables.name, SHARED_WORKER_IMAGE_ENV_VAR),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const decryptedValue = await decryptSecrets<string>(row.value);

  if (decryptedValue === null) {
    return null;
  }

  const value = stringifyDecryptedEnvVarValue(decryptedValue).trim();

  return value || null;
}

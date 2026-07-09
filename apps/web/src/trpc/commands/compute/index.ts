import {
  db,
  deploymentSettings,
  environmentVariables,
  resolveSavedWorkerImage,
  and,
  eq,
  inArray,
  isNull,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  buildSetupComputeStatus,
  deriveWorkerImageFromReleaseVersion,
  getSetupComputeProvider,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isRequiredComputeField,
  isSetupProvisionableComputeProvider,
  NON_SECRET_COMPUTE_ENV_VAR_NAMES,
  normalizeDeploymentComputeConfig,
  presentSetupNewComputeProvisioning,
  resolveDerivedModalBaseImageRef,
  SHARED_WORKER_IMAGE_ENV_VAR,
  type ComputeProvider,
  type DeploymentComputeConfig,
  type SetupComputeStatus,
  type SetupNewComputeProvisioningState,
  type SetupProvisionableComputeProvider,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import {
  assertAdmin,
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';
import {
  getPersistedComputeProvisioning,
  persistComputeProvisioning,
  prepareComputeProvisioningStart,
  runComputeProvisioning,
} from './compute-provisioning';

export async function getPersistedRuntimeComputeConfig(
  executor: DatabaseOrTransaction = db,
): Promise<DeploymentComputeConfig> {
  const [settings] = await executor
    .select({ runtimeComputeConfig: deploymentSettings.runtimeComputeConfig })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeDeploymentComputeConfig(settings?.runtimeComputeConfig);
}

export async function savePersistedRuntimeComputeConfig(
  runtimeComputeConfig: DeploymentComputeConfig,
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .insert(deploymentSettings)
    .values({
      id: 'default',
      runtimeComputeConfig,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        runtimeComputeConfig,
        updatedAt: new Date(),
      },
    });

  return runtimeComputeConfig;
}

/**
 * The worker image hosted providers should provision or derive from, given
 * a value the operator may be submitting in the same request. Process env
 * wins, then the submitted/saved deployment value, then the ref derived from
 * the baked RELEASE_VERSION.
 */
function resolveEffectiveWorkerImageForSave(
  savedOrSubmittedWorkerImage: string | null,
): string | undefined {
  return (
    process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ||
    savedOrSubmittedWorkerImage ||
    deriveWorkerImageFromReleaseVersion(process.env) ||
    undefined
  );
}

export async function getComputeStatusCommand(auth: UserAuthSuccess): Promise<
  SetupComputeStatus & {
    provisioning: Partial<
      Record<
        SetupProvisionableComputeProvider,
        SetupNewComputeProvisioningState | null
      >
    >;
  }
> {
  assertAdmin(auth);

  const [
    persistedEnvVarNames,
    persistedEnvVarValues,
    persistedComputeConfig,
    savedWorkerImage,
    e2bProvisioning,
    daytonaProvisioning,
  ] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
    ]),
    getPersistedRuntimeComputeConfig(),
    resolveSavedWorkerImage(),
    getPersistedComputeProvisioning('e2b'),
    getPersistedComputeProvisioning('daytona'),
  ]);

  return {
    ...buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues,
      persistedComputeConfig,
      savedWorkerImage,
    }),
    // Stale in-flight runs present as failed so the page offers a retry
    // instead of polling forever after a web-process restart.
    provisioning: {
      e2b: presentSetupNewComputeProvisioning(e2bProvisioning),
      daytona: presentSetupNewComputeProvisioning(daytonaProvisioning),
    },
  };
}

export async function saveComputeConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: ComputeProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getSetupComputeProvider(input.provider);

  const provisioningToStart = await db.transaction(async (tx) => {
    const [persistedComputeConfig, persistedEnvVarNames, savedWorkerImage] =
      await Promise.all([
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
        resolveSavedWorkerImage(tx),
      ]);

    // The shared worker image (DOCKER_WORKER_IMAGE) may be submitted in the
    // same request (guided setup) or already saved. Process env still wins
    // and locks the field.
    const workerImageLocked =
      !!process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim();
    const submittedWorkerImage =
      input.values?.[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() || null;
    const savedOrSubmittedWorkerImage = workerImageLocked
      ? null
      : (submittedWorkerImage ?? savedWorkerImage);

    const computeStatus = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig,
      selectedProvider: input.provider,
      savedWorkerImage: savedOrSubmittedWorkerImage,
    });
    const providerStatus = computeStatus.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected compute provider is unavailable.');
    }

    // When the Modal base image is not entered, not env-provided, and not
    // already saved, derive it from the effective worker image and persist it.
    // The published worker image doubles as the Modal base image.
    const derivedInfraDefaults = new Map<string, string>();

    if (input.provider === 'modal') {
      const baseImageField = providerStatus.fields.find(
        (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
      );
      const submittedBaseImage = input.values?.MODAL_BASE_IMAGE_REF?.trim();
      const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
        ...process.env,
        DOCKER_WORKER_IMAGE: resolveEffectiveWorkerImageForSave(
          savedOrSubmittedWorkerImage,
        ),
      });

      if (
        baseImageField &&
        !baseImageField.runtimeSatisfied &&
        !baseImageField.savedSatisfied &&
        !submittedBaseImage &&
        derivedBaseImageRef
      ) {
        derivedInfraDefaults.set('MODAL_BASE_IMAGE_REF', derivedBaseImageRef);
      }
    }

    // Credentials, submitted/derived infrastructure values, and the shared
    // worker image are all persisted as encrypted deployment env vars.
    // Runtime env values are locked and never overwritten from the UI.
    const valuesToSave: Array<{ name: string; value: string }> = [];
    const envVarsToClear: string[] = [];

    if (submittedWorkerImage && !workerImageLocked) {
      valuesToSave.push({
        name: SHARED_WORKER_IMAGE_ENV_VAR,
        value: submittedWorkerImage,
      });
    }

    for (const field of providerStatus.fields) {
      if (field.runtimeSatisfied) {
        continue;
      }

      const submitted = input.values?.[field.envVarName]?.trim() ?? '';
      const nextValue =
        submitted ||
        (isComputeInfrastructureField(field)
          ? (derivedInfraDefaults.get(field.envVarName) ?? '')
          : '');

      if (!nextValue) {
        // Empty secret inputs mean "leave unchanged". Empty optional
        // non-secret inputs clear a previously saved deployment value.
        if (
          field.secret !== true &&
          !isRequiredComputeField(field) &&
          field.savedSatisfied
        ) {
          envVarsToClear.push(field.envVarName);
        }
        continue;
      }

      valuesToSave.push({ name: field.envVarName, value: nextValue });
    }

    // Unlike the setup wizard, saving here does not switch the deployment
    // onto the provider, so only missing account credentials block the save.
    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      if (isComputeInfrastructureField(field)) {
        return false;
      }

      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      return (
        isRequiredComputeField(field) &&
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

    if (envVarsToClear.length > 0) {
      await tx
        .delete(environmentVariables)
        .where(
          and(
            isNull(environmentVariables.userId),
            inArray(environmentVariables.name, envVarsToClear),
          ),
        );
    }

    // Provisionable providers' base images (E2B worker template, Daytona
    // worker snapshot) are artifacts inside the operator's provider account.
    // When the operator did not enter a manual artifact value and the saved
    // credentials + a registry-qualified worker image make provisioning
    // possible, record it as pending and kick it off after commit.
    if (isSetupProvisionableComputeProvider(input.provider)) {
      const provisionableProvider = input.provider;
      const artifactEnvVar =
        provisionableProvider === 'e2b'
          ? 'E2B_TEMPLATE_ID'
          : 'DAYTONA_SNAPSHOT_NAME';
      const manualArtifact = input.values?.[artifactEnvVar]?.trim();
      const credentialsAvailable = providerStatus.fields
        .filter(
          (field) =>
            isComputeCredentialField(field) && isRequiredComputeField(field),
        )
        .every(
          (field) =>
            field.runtimeSatisfied ||
            field.savedSatisfied ||
            (input.values?.[field.envVarName]?.trim() ?? '').length > 0,
        );

      if (!manualArtifact && credentialsAvailable) {
        const existingState = await getPersistedComputeProvisioning(
          provisionableProvider,
          tx,
        );
        const provisioning = await prepareComputeProvisioningStart({
          provider: provisionableProvider,
          providerStatus,
          existingState,
          // The effective image includes the ref derived from the baked
          // RELEASE_VERSION and any worker image saved through the UI, so
          // provisioning also works on deployments that never set
          // DOCKER_WORKER_IMAGE explicitly.
          dockerWorkerImage: resolveEffectiveWorkerImageForSave(
            savedOrSubmittedWorkerImage,
          ),
          runtimeEnv: process.env,
          markPending: (nextState) =>
            persistComputeProvisioning(provisionableProvider, nextState, tx),
        });

        if (provisioning.start) {
          return provisioning.start;
        }
      }
    }

    return null;
  });

  if (provisioningToStart) {
    void runComputeProvisioning({
      userId,
      ...provisioningToStart,
    });
  }
}

/**
 * Saves the shared hosted-compute worker image (`DOCKER_WORKER_IMAGE`) as an
 * encrypted deployment env var. Hosted providers derive or provision their
 * worker base image from this value. A process env value wins and locks the
 * field, so this is a no-op when the worker image is env-provided.
 */
export async function saveComputeWorkerImageCommand(
  auth: UserAuthSuccess,
  input: { value: string },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const value = input.value.trim();

  if (!value) {
    throw new Error('Enter a worker image reference to save.');
  }

  if (process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim()) {
    throw new Error(
      'The worker image is set via an environment variable and cannot be overridden here.',
    );
  }

  await db.transaction(async (tx) => {
    await upsertDeploymentEnvironmentVariables(tx, {
      userId,
      values: [{ name: SHARED_WORKER_IMAGE_ENV_VAR, value }],
    });
  });
}

/**
 * Clears the saved shared worker image deployment env var. Does not affect a
 * worker image provided through the process environment.
 */
export async function clearComputeWorkerImageCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  await db.transaction(async (tx) => {
    await tx
      .delete(environmentVariables)
      .where(
        and(
          isNull(environmentVariables.userId),
          inArray(environmentVariables.name, [SHARED_WORKER_IMAGE_ENV_VAR]),
        ),
      );
  });
}

export async function clearComputeConfigCommand(
  auth: UserAuthSuccess,
  input: { provider: ComputeProvider },
) {
  assertAdmin(auth);

  const provider = getSetupComputeProvider(input.provider);
  // Clears this provider's saved credentials and its provider-specific
  // infrastructure values (base image ref, template id, snapshot name). The
  // shared worker image (DOCKER_WORKER_IMAGE) is not a provider field, so it
  // is left in place and is cleared from its own shared section instead.
  const providerEnvVarNames = provider.fields.map((field) => field.envVarName);

  if (providerEnvVarNames.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(environmentVariables)
      .where(
        and(
          isNull(environmentVariables.userId),
          inArray(environmentVariables.name, providerEnvVarNames),
        ),
      );
  });
}

export async function setDefaultComputeProviderCommand(
  auth: UserAuthSuccess,
  input: { provider: ComputeProvider },
) {
  assertAdmin(auth);

  return db.transaction(async (tx) => {
    const [persistedComputeConfig, persistedEnvVarNames, savedWorkerImage] =
      await Promise.all([
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
        resolveSavedWorkerImage(tx),
      ]);
    const computeStatus = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig,
      selectedProvider: input.provider,
      savedWorkerImage: process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim()
        ? null
        : savedWorkerImage,
    });
    const providerStatus = computeStatus.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected compute provider is unavailable.');
    }

    if (!providerStatus.configSatisfied) {
      throw new Error(
        `Configure ${providerStatus.label} before making it the default compute provider.`,
      );
    }

    const runtimeComputeConfig = normalizeDeploymentComputeConfig({
      defaultProvider: input.provider,
    });

    await savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx);

    return { runtimeComputeConfig };
  });
}

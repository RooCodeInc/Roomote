import {
  db,
  deploymentSettings,
  environmentVariables,
  purgeSavedDeploymentWorkerImage,
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
  getComputeFieldValidationError,
  isAutoProvisionedComputeArtifactField,
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
 * The worker image hosted providers should provision or derive from for this
 * request. Process env wins, then an in-request submitted override (setup only
 * — not persisted as deployment sticky state), then release derivation.
 */
function resolveEffectiveWorkerImageForSave(
  submittedWorkerImage: string | null,
): string | undefined {
  return (
    process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ||
    submittedWorkerImage ||
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

  // Drop sticky DB-backed DOCKER_WORKER_IMAGE rows from the removed Settings
  // editor so release-derived / process-env images always win.
  await purgeSavedDeploymentWorkerImage();

  const [
    persistedEnvVarNames,
    persistedEnvVarValues,
    persistedComputeConfig,
    e2bProvisioning,
    daytonaProvisioning,
    blaxelProvisioning,
  ] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
    ]),
    getPersistedRuntimeComputeConfig(),
    getPersistedComputeProvisioning('e2b'),
    getPersistedComputeProvisioning('daytona'),
    getPersistedComputeProvisioning('blaxel'),
  ]);

  return {
    ...buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues,
      persistedComputeConfig,
    }),
    // Stale in-flight runs present as failed so the page offers a retry
    // instead of polling forever after a web-process restart.
    provisioning: {
      e2b: presentSetupNewComputeProvisioning(e2bProvisioning),
      daytona: presentSetupNewComputeProvisioning(daytonaProvisioning),
      blaxel: presentSetupNewComputeProvisioning(blaxelProvisioning),
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
    await purgeSavedDeploymentWorkerImage(tx);

    const [persistedComputeConfig, persistedEnvVarNames] = await Promise.all([
      getPersistedRuntimeComputeConfig(tx),
      getPersistedEnvironmentVariableNames(tx),
    ]);

    // DOCKER_WORKER_IMAGE may be submitted only for this request (setup).
    // Process env wins; uploaded/DB sticky values are not used.
    const submittedWorkerImage =
      input.values?.[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() || null;
    const effectiveSubmittedWorkerImage = process.env[
      SHARED_WORKER_IMAGE_ENV_VAR
    ]?.trim()
      ? null
      : submittedWorkerImage;

    const computeStatus = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig,
      selectedProvider: input.provider,
    });
    const providerStatus = computeStatus.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected sandbox provider is unavailable.');
    }

    // When the Modal base image is not entered, not env-provided, and not
    // already saved, derive it from the effective worker image and persist it.
    // The published worker image doubles as the Modal base image.
    const derivedInfraDefaults = new Map<string, string>();

    if (input.provider === 'modal') {
      const baseImageField = providerStatus.fields.find(
        (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
      );
      // Never accept a form-submitted MODAL_BASE_IMAGE_REF — derived only.
      const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
        ...process.env,
        DOCKER_WORKER_IMAGE: resolveEffectiveWorkerImageForSave(
          effectiveSubmittedWorkerImage,
        ),
      });

      if (
        baseImageField &&
        !baseImageField.runtimeSatisfied &&
        !baseImageField.savedSatisfied &&
        derivedBaseImageRef
      ) {
        derivedInfraDefaults.set('MODAL_BASE_IMAGE_REF', derivedBaseImageRef);
      }
    }

    // Credentials and operator-editable infrastructure values are persisted as
    // encrypted deployment env vars. DOCKER_WORKER_IMAGE and managed artifacts
    // (Modal base image, E2B/Daytona) are not form-sticky from the UI.
    const valuesToSave: Array<{ name: string; value: string }> = [];
    const envVarsToClear: string[] = [];

    for (const field of providerStatus.fields) {
      if (field.runtimeSatisfied) {
        continue;
      }

      // E2B template / Daytona snapshot are process-env or auto-provisioned
      // only — never sticky-saved from Settings form submissions.
      if (isAutoProvisionedComputeArtifactField(field)) {
        continue;
      }

      // Modal base image is derived server-side; form submissions are ignored.
      const submitted =
        field.envVarName === 'MODAL_BASE_IMAGE_REF'
          ? ''
          : (input.values?.[field.envVarName]?.trim() ?? '');
      const validationError = getComputeFieldValidationError(field, submitted);
      if (validationError) {
        throw new Error(validationError);
      }
      const nextValue =
        submitted ||
        (isComputeInfrastructureField(field)
          ? (derivedInfraDefaults.get(field.envVarName) ?? '')
          : '');

      if (!(nextValue.length > 0)) {
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
    // When credentials + a registry-qualified worker image make provisioning
    // possible and no process-env/saved artifact already satisfies the field,
    // record it as pending and kick it off after commit. Manual form overrides
    // are intentionally not accepted (same treatment as the removed shared
    // worker-image Settings control).
    if (isSetupProvisionableComputeProvider(input.provider)) {
      const provisionableProvider = input.provider;
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

      if (credentialsAvailable) {
        const existingState = await getPersistedComputeProvisioning(
          provisionableProvider,
          tx,
        );
        const provisioning = await prepareComputeProvisioningStart({
          provider: provisionableProvider,
          providerStatus,
          existingState,
          // Process env or in-request override, then RELEASE_VERSION derivation.
          dockerWorkerImage: resolveEffectiveWorkerImageForSave(
            effectiveSubmittedWorkerImage,
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

export async function clearComputeConfigCommand(
  auth: UserAuthSuccess,
  input: { provider: ComputeProvider },
) {
  assertAdmin(auth);

  const provider = getSetupComputeProvider(input.provider);
  // Clears this provider's saved credentials and provider-specific advanced
  // settings/artifacts. Process environment values remain untouched.
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
    await purgeSavedDeploymentWorkerImage(tx);

    const [persistedComputeConfig, persistedEnvVarNames] = await Promise.all([
      getPersistedRuntimeComputeConfig(tx),
      getPersistedEnvironmentVariableNames(tx),
    ]);
    const computeStatus = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig,
      selectedProvider: input.provider,
    });
    const providerStatus = computeStatus.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected sandbox provider is unavailable.');
    }

    if (!providerStatus.configSatisfied) {
      throw new Error(
        `Configure ${providerStatus.label} before making it the default sandbox provider.`,
      );
    }

    const runtimeComputeConfig = normalizeDeploymentComputeConfig({
      defaultProvider: input.provider,
    });

    await savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx);

    return { runtimeComputeConfig };
  });
}

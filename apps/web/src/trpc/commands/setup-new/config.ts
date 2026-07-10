import {
  db,
  environmentVariables,
  and,
  inArray,
  isNull,
  purgeSavedDeploymentWorkerImage,
  isChatGptSubscriptionConnected,
} from '@roomote/db/server';
import {
  buildSetupAuthStatus,
  buildSetupComputeStatus,
  collectSetupModelProviderCredentialValues,
  deriveWorkerImageFromReleaseVersion,
  getSetupAuthProvider,
  getSetupComputeProvider,
  getSetupModelProvider,
  isAutoProvisionedComputeArtifactField,
  isComputeInfrastructureField,
  isConfiguredEnvValue,
  isRequiredComputeField,
  normalizeDeploymentComputeConfig,
  normalizeDeploymentModelConfig,
  getSetupNewComputeProvisioningState,
  isSetupProvisionableComputeProvider,
  normalizeSetupNewState,
  resolveDerivedModalBaseImageRef,
  SETUP_COMPUTE_PROVISIONING_STATE_FIELDS,
  SHARED_WORKER_IMAGE_ENV_VAR,
  type ComputeProvider,
  type SetupAuthProviderId,
  type SetupModelProviderId,
  type SetupProvisionableComputeProvider,
  type SourceControlProvider,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  assertSetupTokenValid,
  getRequestInviteToken,
  isSetupTokenRequired,
  isSetupTokenValid,
} from '@/lib/server';

import { assertAdmin, getSetupBootstrapState } from '../setup/shared';
import {
  getPersistedEnvironmentVariableNames,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';
import {
  getPersistedRuntimeComputeConfig,
  savePersistedRuntimeComputeConfig,
} from '../compute';
import {
  createPendingComputeProvisioning,
  prepareComputeProvisioningStart,
  runComputeProvisioning,
} from '../compute/compute-provisioning';
import {
  assertValidSourceControlConfigInput,
  saveSourceControlConfigValues,
} from '../source-control';
import { getPersistedRawTaskModelSettings } from '../task-models';
import {
  buildAutoAddedTaskModelSettings,
  collectConnectedTaskModelProviderIds,
} from '../task-models/auto-add-models';
import {
  ensureSetupBootstrapAuditUser,
  assertSetupBootstrapOpen,
  getPersistedSetupNewState,
  savePersistedSetupNewState,
  savePersistedRuntimeModelConfig,
  savePersistedTaskModelSettings,
} from './shared';

export async function saveSetupNewModelConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupModelProviderId;
    apiKey?: string;
    additionalEnvValues?: Record<string, string>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getSetupModelProvider(input.provider);
  const isOauthProvider = provider.authKind === 'oauth';

  const chatgptConnected = await isChatGptSubscriptionConnected();

  // OAuth providers (the ChatGPT subscription) are connected through the
  // device-code flow rather than an API key. The setup wizard's Continue
  // records the provider choice and default model only after the operator
  // has connected an account, so the env-vars step becomes satisfied without
  // a credential env var.
  if (isOauthProvider && !chatgptConnected) {
    throw new Error(
      `Connect your ${provider.label} account to continue, or pick a different provider.`,
    );
  }

  return db.transaction(async (tx) => {
    const [currentState, persistedEnvVarNames, persistedTaskModelSettings] =
      await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedEnvironmentVariableNames(tx),
        getPersistedRawTaskModelSettings(tx),
      ]);
    const persistedEnvVarNameSet = new Set(persistedEnvVarNames);

    if (!isOauthProvider) {
      const { values: credentialValues, clearedEnvVarNames } =
        collectSetupModelProviderCredentialValues({
          provider,
          apiKey: input.apiKey,
          additionalEnvValues: input.additionalEnvValues,
          isEnvVarSatisfied: (envVarName) =>
            persistedEnvVarNameSet.has(envVarName) ||
            isConfiguredEnvValue(process.env[envVarName]),
          action: 'continue',
        });

      if (credentialValues.length > 0) {
        await upsertDeploymentEnvironmentVariables(tx, {
          userId,
          values: credentialValues,
        });
      }

      // Optional fields submitted as blank clear their previously saved value
      // (deployment-level rows only, mirroring how they are stored).
      const clearedPersistedEnvVarNames = clearedEnvVarNames.filter((name) =>
        persistedEnvVarNameSet.has(name),
      );

      if (clearedPersistedEnvVarNames.length > 0) {
        await tx
          .delete(environmentVariables)
          .where(
            and(
              isNull(environmentVariables.userId),
              inArray(environmentVariables.name, clearedPersistedEnvVarNames),
            ),
          );
      }
    }

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      modelProvider: input.provider,
      lastInteractedByUserId: userId,
    });
    const runtimeModelConfig = normalizeDeploymentModelConfig({
      roomoteModel: provider.defaultRoomoteModel,
    });

    // Mirror the models settings page: connecting a provider the deployment
    // has no models for yet auto-adds its recommended models so the first
    // launch offers a usable model list.
    const connectedProviderIds = new Set<string>([
      provider.id,
      ...collectConnectedTaskModelProviderIds({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        chatgptConnected,
      }),
    ]);
    const autoAdd = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings,
      connectedProviderIds,
    });

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      savePersistedRuntimeModelConfig(runtimeModelConfig, tx),
      ...(autoAdd
        ? [savePersistedTaskModelSettings(autoAdd.taskModelSettings, tx)]
        : []),
    ]);

    return {
      setupNewState,
      runtimeModelConfig,
    };
  });
}

export async function saveSetupNewComputeProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: ComputeProvider;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const [currentState, persistedRuntimeComputeConfig, persistedEnvVarNames] =
      await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
      ]);
    const computeSetup = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig: persistedRuntimeComputeConfig,
      selectedProvider: input.provider,
    });
    const providerStatus = computeSetup.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected sandbox provider is unavailable.');
    }

    const hasCredentialFields = providerStatus.fields.length > 0;
    const runtimeComputeConfig = hasCredentialFields
      ? persistedRuntimeComputeConfig
      : normalizeDeploymentComputeConfig({
          defaultProvider: input.provider,
        });

    // Providers with credentials are only recorded as the wizard choice here.
    // The runtime default commits when their config step is confirmed, so
    // merely browsing a hosted provider must not switch the deployment onto it.
    // Credentialless providers such as Local Docker have no config step to
    // confirm, so choosing them commits the runtime default immediately.
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      computeProvider: input.provider,
      lastInteractedByUserId: userId,
    });

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      ...(hasCredentialFields
        ? []
        : [savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx)]),
    ]);

    return {
      setupNewState,
      runtimeComputeConfig,
    };
  });
}

export async function saveSetupNewComputeConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: ComputeProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getSetupComputeProvider(input.provider);

  const { provisioningToStart, ...result } = await db.transaction(
    async (tx) => {
      // Resolved inside the transaction, kicked off only after it commits so
      // the detached build reads the credentials the save just persisted.
      let provisioningToStart: {
        provider: SetupProvisionableComputeProvider;
        imageRef: string;
        templateRef: string;
      } | null = null;

      await purgeSavedDeploymentWorkerImage(tx);

      const [
        currentState,
        persistedRuntimeComputeConfig,
        persistedEnvVarNames,
      ] = await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
      ]);

      // In-request DOCKER_WORKER_IMAGE is only used for this save/provisioning
      // pass. It is not persisted as sticky deployment state; process env and
      // RELEASE_VERSION derivation own runtime configuration.
      const submittedWorkerImage =
        input.values?.[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() || null;
      const effectiveWorkerImage =
        process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ||
        submittedWorkerImage ||
        deriveWorkerImageFromReleaseVersion(process.env) ||
        undefined;

      const computeSetup = buildSetupComputeStatus({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        persistedComputeConfig: persistedRuntimeComputeConfig,
        selectedProvider: input.provider,
      });
      const providerStatus = computeSetup.providers.find(
        (candidate) => candidate.provider === input.provider,
      );

      if (!providerStatus) {
        throw new Error('Selected sandbox provider is unavailable.');
      }

      // Derive MODAL_BASE_IMAGE_REF when not env-provided or already saved.
      // Form submissions are ignored (deployment-managed like E2B/Daytona
      // artifacts).
      const derivedInfraDefaults = new Map<string, string>();

      if (input.provider === 'modal') {
        const baseImageField = providerStatus.fields.find(
          (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
        );
        const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
          ...process.env,
          DOCKER_WORKER_IMAGE: effectiveWorkerImage,
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

      // Provisionable providers' base images (the E2B worker template, the
      // Daytona worker snapshot) cannot be derived like the Modal base image
      // — they are artifacts inside the operator's provider account. Manual
      // form overrides are not accepted; process env or auto-provisioning
      // owns them. When a registry-qualified worker image exists, the save
      // records credentials, marks the run as pending, and the run executes
      // detached after commit.
      const setupProvisioningFieldNames = new Set<string>();

      if (isSetupProvisionableComputeProvider(input.provider)) {
        const provisionableProvider = input.provider;
        const artifactEnvVar =
          provisionableProvider === 'e2b'
            ? 'E2B_TEMPLATE_ID'
            : 'DAYTONA_SNAPSHOT_NAME';
        const provisioning = await prepareComputeProvisioningStart({
          provider: provisionableProvider,
          providerStatus,
          existingState: getSetupNewComputeProvisioningState(
            currentState,
            provisionableProvider,
          ),
          // Process env, in-request override, or RELEASE_VERSION derivation.
          dockerWorkerImage: effectiveWorkerImage,
          runtimeEnv: process.env,
          markPending: (nextState) => {
            provisioningToStart = {
              provider: provisionableProvider,
              imageRef: nextState.imageRef,
              templateRef: nextState.templateRef ?? '',
            };
          },
        });

        if (provisioning.fieldPending) {
          if (!provisioning.provisionable) {
            throw new Error(
              `${providerStatus.label} needs a registry-qualified worker image (for example via DOCKER_WORKER_IMAGE) so Roomote can provision the worker base image automatically.`,
            );
          }

          setupProvisioningFieldNames.add(artifactEnvVar);
        }

        if (provisioning.start) {
          provisioningToStart = provisioning.start;
        }
      }

      // Credentials and operator-editable infrastructure are persisted as
      // encrypted deployment env vars. Managed artifacts are process-env /
      // derived / provisioning only.
      const valuesToSave: Array<{ name: string; value: string }> = [];
      const envVarsToClear: string[] = [];

      for (const field of providerStatus.fields) {
        if (field.runtimeSatisfied) {
          continue;
        }

        if (isAutoProvisionedComputeArtifactField(field)) {
          continue;
        }

        const submitted =
          field.envVarName === 'MODAL_BASE_IMAGE_REF'
            ? ''
            : (input.values?.[field.envVarName]?.trim() ?? '');
        const nextValue =
          submitted ||
          (isComputeInfrastructureField(field)
            ? (derivedInfraDefaults.get(field.envVarName) ?? '')
            : '');

        if (!nextValue) {
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

      const hasMissingRequiredValue = providerStatus.fields.some((field) => {
        if (setupProvisioningFieldNames.has(field.envVarName)) {
          return false;
        }

        // Modal base image is not form-collected; only runtime / saved / derived
        // values count toward satisfaction (same as the save loop above).
        const submitted =
          field.envVarName === 'MODAL_BASE_IMAGE_REF'
            ? ''
            : (input.values?.[field.envVarName]?.trim() ?? '');
        const nextValue =
          submitted ||
          (isComputeInfrastructureField(field)
            ? (derivedInfraDefaults.get(field.envVarName) ?? '')
            : '');

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

      const setupNewState = normalizeSetupNewState({
        ...currentState,
        computeProvider: input.provider,
        ...(provisioningToStart
          ? {
              [SETUP_COMPUTE_PROVISIONING_STATE_FIELDS[
                provisioningToStart.provider
              ]]: createPendingComputeProvisioning(provisioningToStart),
            }
          : {}),
        lastInteractedByUserId: userId,
      });
      const runtimeComputeConfig = normalizeDeploymentComputeConfig({
        defaultProvider: input.provider,
      });

      await Promise.all([
        savePersistedSetupNewState(setupNewState, tx),
        savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx),
      ]);

      return {
        setupNewState,
        runtimeComputeConfig,
        provisioningToStart,
      };
    },
  );

  if (provisioningToStart) {
    void runComputeProvisioning({
      userId,
      ...provisioningToStart,
    });
  }

  return result;
}

export async function saveSetupNewAuthProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupAuthProviderId;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  return saveSetupAuthProviderChoice({
    provider: input.provider,
    actorUserId: userId,
  });
}

async function saveSetupAuthProviderChoice(input: {
  provider: SetupAuthProviderId;
  actorUserId: string | null;
  requireBootstrapOpen?: boolean;
}) {
  if (input.requireBootstrapOpen) {
    await assertSetupBootstrapOpen();
  }

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      authProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

export async function saveSetupNewAuthConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupAuthProviderId;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  return saveSetupAuthConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: userId,
  });
}

async function saveSetupAuthConfig(input: {
  provider: SetupAuthProviderId;
  values?: Partial<Record<string, string>>;
  actorUserId: string | null;
  requireBootstrapOpen?: boolean;
}) {
  if (input.requireBootstrapOpen) {
    await assertSetupBootstrapOpen();
  }
  const provider = getSetupAuthProvider(input.provider);

  return db.transaction(async (tx) => {
    const [currentState, persistedEnvVarNames] = await Promise.all([
      getPersistedSetupNewState(tx),
      getPersistedEnvironmentVariableNames(tx),
    ]);
    const authSetup = buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      selectedProvider: input.provider,
    });
    const providerStatus = authSetup.providers.find(
      (candidate) => candidate.id === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected auth provider is unavailable.');
    }

    const valuesToSave = providerStatus.fields.flatMap((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      if (!nextValue) {
        return [];
      }

      return [
        {
          name: field.envVarName,
          value: nextValue,
        },
      ];
    });

    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      return (
        field.required !== false &&
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
      const auditUserId =
        input.actorUserId ?? (await ensureSetupBootstrapAuditUser(tx));

      await upsertDeploymentEnvironmentVariables(tx, {
        userId: auditUserId,
        values: valuesToSave,
      });
    }

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      authProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

export async function saveSetupNewSourceControlProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlProvider;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      sourceControlProvider: input.provider,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

export async function saveSetupNewSourceControlConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return saveSourceControlConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: userId,
  });
}

async function saveSourceControlConfig(input: {
  provider: SourceControlProvider;
  values?: Partial<Record<string, string>>;
  actorUserId: string;
}) {
  // Provider-API validation happens before the transaction so the external
  // HTTP round-trip never holds a pooled DB connection open.
  await assertValidSourceControlConfigInput(input);

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);

    await saveSourceControlConfigValues({
      executor: tx,
      actorUserId: input.actorUserId,
      provider: input.provider,
      values: input.values,
    });

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      sourceControlProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

/**
 * Resolves the setup token for bootstrap commands: the explicit input when
 * the client still has it (e.g. from the ?token= query param), otherwise the
 * invite cookie, which is the only place the token survives OAuth sign-in
 * round-trips.
 */
async function resolveSetupTokenInput(
  setupToken: string | undefined,
): Promise<string | undefined> {
  if (setupToken != null) {
    return setupToken;
  }

  return (await getRequestInviteToken()) ?? undefined;
}

export async function getSetupBootstrapStatusCommand(input?: {
  setupToken?: string;
}) {
  const bootstrapState = await getSetupBootstrapState();
  const setupTokenRequired = bootstrapState.setupOpen && isSetupTokenRequired();

  if (
    setupTokenRequired &&
    !isSetupTokenValid(await resolveSetupTokenInput(input?.setupToken))
  ) {
    return {
      setupOpen: bootstrapState.setupOpen,
      setupTokenRequired,
      setupTokenSatisfied: false,
      authSetup: null,
    };
  }

  const [setupNewState, persistedEnvVarNames] = await Promise.all([
    getPersistedSetupNewState(),
    getPersistedEnvironmentVariableNames(),
  ]);

  return {
    setupOpen: bootstrapState.setupOpen,
    setupTokenRequired,
    setupTokenSatisfied: true,
    authSetup: buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      selectedProvider: setupNewState.authProvider,
    }),
  };
}

export async function saveSetupBootstrapAuthProviderChoiceCommand(input: {
  provider: SetupAuthProviderId;
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input.setupToken));

  return saveSetupAuthProviderChoice({
    provider: input.provider,
    actorUserId: null,
    requireBootstrapOpen: true,
  });
}

export async function saveSetupBootstrapAuthConfigCommand(input: {
  provider: SetupAuthProviderId;
  values?: Partial<Record<string, string>>;
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input.setupToken));

  return saveSetupAuthConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: null,
    requireBootstrapOpen: true,
  });
}

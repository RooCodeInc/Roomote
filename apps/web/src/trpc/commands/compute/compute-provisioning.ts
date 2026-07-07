import {
  db,
  deploymentSettings,
  eq,
  resolveComputeProviderEnvValues,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  buildE2bWorkerTemplate,
  deriveDaytonaWorkerSnapshotName,
  deriveE2bWorkerTemplateRef,
  registerDaytonaWorkerSnapshot,
} from '@roomote/compute-providers';
import {
  isSetupNewComputeProvisioningStale,
  normalizeSetupNewState,
  resolveDerivedModalBaseImageRef,
  SETUP_COMPUTE_PROVISIONING_STALE_MS,
  SETUP_COMPUTE_PROVISIONING_STATE_FIELDS,
  type SetupComputeProviderStatus,
  type SetupNewComputeProvisioningState,
  type SetupProvisionableComputeProvider,
} from '@roomote/types';

import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

/**
 * Shared worker base-image provisioning used by both the setup wizard and
 * the Settings → Compute page. Provisionable providers' base images are
 * artifacts inside the operator's provider account (the E2B worker template,
 * the Daytona worker snapshot), so saving credentials from either surface
 * can kick off a detached provisioning run; progress lives on the
 * provider's SetupNewState field regardless of which surface started it.
 *
 * The setupNewState read/write below is intentionally local: the setup-new
 * command module owns the full state but already imports from '../compute',
 * so importing its helpers here would create a cycle.
 */

interface ProvisioningProviderConfig {
  envVarName: string;
  deriveArtifactRef: (imageRef: string) => string;
  provision: (input: {
    resolvedEnv: Partial<Record<string, string>>;
    imageRef: string;
    templateRef: string;
  }) => Promise<{ artifactRef: string }>;
}

const PROVISIONING_PROVIDERS: Record<
  SetupProvisionableComputeProvider,
  ProvisioningProviderConfig
> = {
  e2b: {
    envVarName: 'E2B_TEMPLATE_ID',
    deriveArtifactRef: deriveE2bWorkerTemplateRef,
    provision: async ({ resolvedEnv, imageRef, templateRef }) => {
      const apiKey = resolvedEnv.E2B_API_KEY;

      if (!apiKey) {
        throw new Error('E2B_API_KEY is not configured');
      }

      const built = await buildE2bWorkerTemplate({
        apiKey,
        domain: resolvedEnv.E2B_DOMAIN,
        imageRef,
        templateRef,
        registryUsername:
          process.env.E2B_REGISTRY_USERNAME ||
          process.env.MODAL_REGISTRY_USERNAME,
        registryPassword:
          process.env.E2B_REGISTRY_PASSWORD ||
          process.env.MODAL_REGISTRY_PASSWORD,
      });

      return { artifactRef: built.templateRef };
    },
  },
  daytona: {
    envVarName: 'DAYTONA_SNAPSHOT_NAME',
    deriveArtifactRef: deriveDaytonaWorkerSnapshotName,
    provision: async ({ resolvedEnv, imageRef, templateRef }) => {
      const apiKey = resolvedEnv.DAYTONA_API_KEY;

      if (!apiKey) {
        throw new Error('DAYTONA_API_KEY is not configured');
      }

      // Daytona snapshot registration has no per-call registry credentials:
      // the worker image must be public or its registry configured in the
      // Daytona organization.
      const registered = await registerDaytonaWorkerSnapshot({
        apiKey,
        apiUrl: resolvedEnv.DAYTONA_API_URL,
        target: resolvedEnv.DAYTONA_TARGET,
        imageRef,
        snapshotName: templateRef,
      });

      return { artifactRef: registered.snapshotName };
    },
  },
};

async function getPersistedSetupNewStateValue(executor: DatabaseOrTransaction) {
  const [settings] = await executor
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

export async function getPersistedComputeProvisioning(
  provider: SetupProvisionableComputeProvider,
  executor: DatabaseOrTransaction = db,
): Promise<SetupNewComputeProvisioningState | null> {
  const state = await getPersistedSetupNewStateValue(executor);

  return state[SETUP_COMPUTE_PROVISIONING_STATE_FIELDS[provider]];
}

export async function persistComputeProvisioning(
  provider: SetupProvisionableComputeProvider,
  provisioning: SetupNewComputeProvisioningState,
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  const stateField = SETUP_COMPUTE_PROVISIONING_STATE_FIELDS[provider];
  const state = await getPersistedSetupNewStateValue(executor);
  const setupNewState = normalizeSetupNewState({
    ...state,
    [stateField]: {
      ...provisioning,
      // A `building` write marks the start of a NEW attempt and must carry a
      // fresh startedAt — inheriting the prior one would make a retry after
      // a stale run instantly stale again. Terminal writes keep the
      // attempt's original startedAt so the record reflects the real span.
      startedAt:
        provisioning.status === 'building'
          ? provisioning.startedAt
          : (state[stateField]?.startedAt ?? provisioning.startedAt),
    },
  });

  await executor
    .insert(deploymentSettings)
    .values({
      id: 'default',
      setupNewState,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        setupNewState,
        updatedAt: new Date(),
      },
    });
}

interface ComputeProvisioningPlan {
  /** The infra field is required and not satisfied by env or saved vars. */
  artifactPending: boolean;
  /** A registry-qualified worker image exists to provision from. */
  provisionable: boolean;
  /** Run to start now; null when not provisionable or a fresh run is in flight. */
  runToStart: { imageRef: string; templateRef: string } | null;
}

function planComputeProvisioning({
  provider,
  providerStatus,
  existingState,
  dockerWorkerImage,
  runtimeEnv,
}: {
  provider: SetupProvisionableComputeProvider;
  providerStatus: SetupComputeProviderStatus;
  existingState: SetupNewComputeProvisioningState | null;
  dockerWorkerImage: string | undefined;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
}): ComputeProvisioningPlan {
  const config = PROVISIONING_PROVIDERS[provider];
  const artifactField = providerStatus.fields.find(
    (field) => field.envVarName === config.envVarName,
  );

  const artifactPending =
    !!artifactField &&
    !artifactField.runtimeSatisfied &&
    !artifactField.savedSatisfied;

  if (!artifactPending) {
    return { artifactPending: false, provisionable: false, runToStart: null };
  }

  const workerImageRef = resolveDerivedModalBaseImageRef({
    ...(runtimeEnv ?? process.env),
    ...(dockerWorkerImage !== undefined
      ? { DOCKER_WORKER_IMAGE: dockerWorkerImage }
      : {}),
  });

  if (!workerImageRef) {
    return { artifactPending: true, provisionable: false, runToStart: null };
  }

  const runInFlight =
    existingState?.status === 'building' &&
    !isSetupNewComputeProvisioningStale(existingState);

  return {
    artifactPending: true,
    provisionable: true,
    runToStart: runInFlight
      ? null
      : {
          imageRef: workerImageRef,
          templateRef: config.deriveArtifactRef(workerImageRef),
        },
  };
}

export function createPendingComputeProvisioning({
  imageRef,
  templateRef,
}: {
  imageRef: string;
  templateRef: string;
}): SetupNewComputeProvisioningState {
  return {
    status: 'building',
    imageRef,
    templateRef,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

type ComputeProvisioningStart = {
  provider: SetupProvisionableComputeProvider;
  imageRef: string;
  templateRef: string;
};

export async function prepareComputeProvisioningStart(input: {
  provider: SetupProvisionableComputeProvider;
  providerStatus: SetupComputeProviderStatus;
  existingState: SetupNewComputeProvisioningState | null;
  dockerWorkerImage: string | undefined;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
  markPending: (
    nextState: SetupNewComputeProvisioningState,
  ) => Promise<void> | void;
}): Promise<{
  fieldPending: boolean;
  provisionable: boolean;
  start: ComputeProvisioningStart | null;
}> {
  const plan = planComputeProvisioning({
    provider: input.provider,
    providerStatus: input.providerStatus,
    existingState: input.existingState,
    dockerWorkerImage: input.dockerWorkerImage,
    runtimeEnv: input.runtimeEnv,
  });

  if (plan.runToStart) {
    await input.markPending(createPendingComputeProvisioning(plan.runToStart));

    return {
      fieldPending: true,
      provisionable: true,
      start: {
        provider: input.provider,
        ...plan.runToStart,
      },
    };
  }

  return {
    fieldPending: plan.artifactPending,
    provisionable: plan.provisionable,
    start: null,
  };
}

/**
 * Hard ceiling on a provisioning run. It must stay under
 * SETUP_COMPUTE_PROVISIONING_STALE_MS so a slow run is recorded as failed by
 * the runner before the read-time staleness fallback declares it dead —
 * otherwise a still-running run could present as failed and a retry could
 * start a concurrent duplicate.
 */
const COMPUTE_PROVISIONING_TIMEOUT_MS = 8 * 60_000;

if (COMPUTE_PROVISIONING_TIMEOUT_MS >= SETUP_COMPUTE_PROVISIONING_STALE_MS) {
  throw new Error(
    'COMPUTE_PROVISIONING_TIMEOUT_MS must stay below SETUP_COMPUTE_PROVISIONING_STALE_MS',
  );
}

/**
 * In-process claim preventing duplicate concurrent runs for the same
 * artifact. Both initiating surfaces run in this web process (the detached
 * runner only ever runs where the save committed), so this closes the
 * realistic race of two near-simultaneous saves both observing no in-flight
 * run. The persisted `building` state remains the cross-restart guard; a
 * locked read is deliberately not used because the settings row is a
 * single-operator surface and a duplicated run for the same artifact ref is
 * idempotent on the provider side.
 */
const activeProvisioningClaims = new Set<string>();

async function withProvisioningTimeout<T>(
  promise: Promise<T>,
  templateRef: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Provisioning ${templateRef} exceeded ${COMPUTE_PROVISIONING_TIMEOUT_MS / 60_000} minutes and was abandoned. Retry to start a new run.`,
            ),
          );
        }, COMPUTE_PROVISIONING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // An abandoned provider-side run keeps going in the provider's cloud;
    // that is harmless because a retry re-provisions the same artifact ref.
    promise.catch(() => {});
  }
}

/**
 * Detached provisioning run. Executes in the web process after the
 * initiating save commits; progress is persisted on the provider's
 * SetupNewState field. A web-process restart mid-run leaves a stale
 * `building` entry, which reads as failed after
 * SETUP_COMPUTE_PROVISIONING_STALE_MS so the operator can retry from either
 * surface.
 */
export async function runComputeProvisioning({
  provider,
  userId,
  imageRef,
  templateRef,
}: {
  provider: SetupProvisionableComputeProvider;
  userId: string;
  imageRef: string;
  templateRef: string;
}): Promise<void> {
  const config = PROVISIONING_PROVIDERS[provider];
  const claimKey = `${provider}:${templateRef}`;

  if (activeProvisioningClaims.has(claimKey)) {
    console.warn(
      `[runComputeProvisioning] Skipping duplicate concurrent run for ${claimKey}`,
    );
    return;
  }

  activeProvisioningClaims.add(claimKey);

  try {
    console.log(
      `[runComputeProvisioning] Provisioning worker base image ${JSON.stringify(
        { provider, imageRef, templateRef },
      )}`,
    );

    // The credentials were persisted by the initiating save; resolve them
    // the same way the runtime does (process env first, encrypted deployment
    // env vars as the fallback).
    const resolvedEnv = await resolveComputeProviderEnvValues(provider);

    const { artifactRef } = await withProvisioningTimeout(
      config.provision({ resolvedEnv, imageRef, templateRef }),
      templateRef,
    );

    await db.transaction(async (tx) => {
      await upsertDeploymentEnvironmentVariables(tx, {
        userId,
        values: [{ name: config.envVarName, value: artifactRef }],
      });

      await persistComputeProvisioning(
        provider,
        {
          status: 'succeeded',
          imageRef,
          templateRef: artifactRef,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
        tx,
      );
    });

    console.log(
      `[runComputeProvisioning] Provisioning succeeded ${JSON.stringify({
        provider,
        artifactRef,
      })}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[runComputeProvisioning] Provisioning failed ${JSON.stringify({
        provider,
        imageRef,
        templateRef,
        error: message,
      })}`,
    );

    await persistComputeProvisioning(provider, {
      status: 'failed',
      imageRef,
      templateRef: null,
      error: message,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }).catch((persistError) => {
      console.error(
        `[runComputeProvisioning] Failed to persist provisioning failure: ${
          persistError instanceof Error
            ? persistError.message
            : String(persistError)
        }`,
      );
    });
  } finally {
    activeProvisioningClaims.delete(claimKey);
  }
}

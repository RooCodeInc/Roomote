import {
  and,
  db,
  deploymentSettings,
  eq,
  sql,
  taskRuns,
  resolveComputeProviderEnvValues,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { queuePersistedTaskRun } from '@roomote/cloud-agents/server';
import {
  buildBlaxelWorkerImage,
  buildE2bWorkerTemplate,
  deriveBlaxelWorkerImageName,
  deriveDaytonaWorkerSnapshotName,
  deriveE2bWorkerTemplateRef,
  registerDaytonaWorkerSnapshot,
} from '@roomote/compute-providers';
import {
  isSetupNewComputeProvisioningStale,
  buildSetupComputeStatus,
  NON_SECRET_COMPUTE_ENV_VAR_NAMES,
  normalizeSetupNewState,
  RunStatus,
  resolveDerivedModalBaseImageRef,
  SETUP_COMPUTE_PROVISIONING_STALE_MS,
  SETUP_COMPUTE_PROVISIONING_STATE_FIELDS,
  WORKER_RUNTIME_SCHEMA_VERSION,
  type SetupComputeProviderStatus,
  type SetupNewComputeProvisioningState,
  type SetupProvisionableComputeProvider,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import {
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';

/**
 * Shared worker base-image provisioning used by both the setup wizard and
 * the Settings → Sandboxes page. Provisionable providers' base images are
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
  blaxel: {
    envVarName: 'BLAXEL_IMAGE',
    deriveArtifactRef: deriveBlaxelWorkerImageName,
    provision: async ({ resolvedEnv, imageRef, templateRef }) => {
      const apiKey = resolvedEnv.BL_API_KEY;
      const workspace = resolvedEnv.BL_WORKSPACE;

      if (!apiKey) throw new Error('BL_API_KEY is not configured');
      if (!workspace) throw new Error('BL_WORKSPACE is not configured');

      // Blaxel's image builder currently relies on registry access configured
      // in the workspace; it does not accept per-call registry credentials.
      const built = await buildBlaxelWorkerImage({
        apiKey,
        workspace,
        imageRef,
        imageName: templateRef,
      });

      return { artifactRef: built.imageRef };
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

/** Serializes desired-state transitions and terminal result publication. */
export async function acquireComputeProvisioningLock(
  provider: SetupProvisionableComputeProvider,
  executor: DatabaseOrTransaction,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`compute-provisioning:${provider}`}))`,
  );
}

function isCurrentComputeProvisioningAttempt(
  current: SetupNewComputeProvisioningState | null,
  expected: { imageRef: string; templateRef: string },
): boolean {
  return (
    current?.status === 'building' &&
    current.runtimeSchemaVersion === WORKER_RUNTIME_SCHEMA_VERSION &&
    current.imageRef === expected.imageRef &&
    current.templateRef === expected.templateRef
  );
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

  // A process-env artifact is operator-managed and always wins. Saved
  // artifacts are Roomote-managed, so they are current only when the
  // persisted successful build matches both the desired worker image and the
  // runtime schema. Missing version metadata intentionally forces one rebuild.
  if (!artifactField || artifactField.runtimeSatisfied) {
    return { artifactPending: false, provisionable: false, runToStart: null };
  }

  const workerImageRef = resolveDerivedModalBaseImageRef({
    ...(runtimeEnv ?? process.env),
    ...(dockerWorkerImage !== undefined
      ? { DOCKER_WORKER_IMAGE: dockerWorkerImage }
      : {}),
  });

  if (!workerImageRef) {
    return {
      artifactPending: !artifactField.savedSatisfied,
      provisionable: false,
      runToStart: null,
    };
  }

  const managedArtifactCurrent =
    artifactField.savedSatisfied &&
    existingState?.status === 'succeeded' &&
    existingState.imageRef === workerImageRef &&
    existingState.runtimeSchemaVersion === WORKER_RUNTIME_SCHEMA_VERSION;

  if (managedArtifactCurrent) {
    return { artifactPending: false, provisionable: false, runToStart: null };
  }

  const runInFlight =
    existingState?.status === 'building' &&
    existingState.imageRef === workerImageRef &&
    existingState.runtimeSchemaVersion === WORKER_RUNTIME_SCHEMA_VERSION &&
    !isSetupNewComputeProvisioningStale(existingState);

  return {
    // A saved artifact remains usable while its replacement builds. Only
    // first-time provisioning blocks setup/task readiness.
    artifactPending: !artifactField.savedSatisfied,
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
    runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
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

function getProvisioningFailureTaskMessage(message: string): string {
  return `Sandbox provider provisioning failed: ${message} Retry provisioning in Settings → Sandboxes.`;
}

async function clearWaitingTaskProvisioningErrors(
  provider: SetupProvisionableComputeProvider,
): Promise<void> {
  await db
    .update(taskRuns)
    .set({ error: null })
    .where(
      and(
        eq(taskRuns.vendor, provider),
        eq(taskRuns.status, RunStatus.Pending),
        eq(taskRuns.taskPhase, WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE),
      ),
    );
}

async function failWaitingTasksForProvisioning(
  provider: SetupProvisionableComputeProvider,
  message: string,
): Promise<void> {
  await db
    .update(taskRuns)
    .set({ error: getProvisioningFailureTaskMessage(message) })
    .where(
      and(
        eq(taskRuns.vendor, provider),
        eq(taskRuns.status, RunStatus.Pending),
        eq(taskRuns.taskPhase, WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE),
      ),
    );
}

export async function dispatchWaitingTasksForProvisioning(
  provider: SetupProvisionableComputeProvider,
): Promise<void> {
  // Clearing the wait phase is the durable release. If this process exits
  // before Redis enqueue completes, the normal pending-run orphan recovery
  // will pick the run up instead of leaving it blocked indefinitely.
  const waitingRuns = await db
    .update(taskRuns)
    .set({ taskPhase: null, error: null })
    .where(
      and(
        eq(taskRuns.vendor, provider),
        eq(taskRuns.status, RunStatus.Pending),
        eq(taskRuns.taskPhase, WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE),
      ),
    )
    .returning();

  const dispatches = await Promise.allSettled(
    waitingRuns.map((taskRun) => queuePersistedTaskRun(taskRun)),
  );

  for (const [index, dispatch] of dispatches.entries()) {
    if (dispatch.status === 'rejected') {
      console.error(
        `[dispatchWaitingTasksForProvisioning] Failed to queue run ${waitingRuns[index]?.id}: ${
          dispatch.reason instanceof Error
            ? dispatch.reason.message
            : String(dispatch.reason)
        }`,
      );
    }
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
  userId: string | null;
  imageRef: string;
  templateRef: string;
}): Promise<void> {
  const config = PROVISIONING_PROVIDERS[provider];
  // The image ref is part of the desired build identity. Two registries can
  // use the same tag/template name, and a newer desired image must not be
  // suppressed by an older in-process build with that name.
  const claimKey = `${provider}:${imageRef}:${templateRef}`;

  if (activeProvisioningClaims.has(claimKey)) {
    console.warn(
      `[runComputeProvisioning] Skipping duplicate concurrent run for ${claimKey}`,
    );
    return;
  }

  activeProvisioningClaims.add(claimKey);

  try {
    await clearWaitingTaskProvisioningErrors(provider).catch((error) => {
      console.error(
        `[runComputeProvisioning] Failed to clear queued-task provisioning errors: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

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

    const activated = await db.transaction(async (tx) => {
      await acquireComputeProvisioningLock(provider, tx);
      const current = await getPersistedComputeProvisioning(provider, tx);

      if (
        !isCurrentComputeProvisioningAttempt(current, {
          imageRef,
          templateRef,
        })
      ) {
        return false;
      }

      await upsertDeploymentEnvironmentVariables(tx, {
        userId,
        values: [{ name: config.envVarName, value: artifactRef }],
      });

      await persistComputeProvisioning(
        provider,
        {
          status: 'succeeded',
          runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
          imageRef,
          templateRef: artifactRef,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
        tx,
      );

      return true;
    });

    if (!activated) {
      console.warn(
        `[runComputeProvisioning] Ignoring superseded successful build ${JSON.stringify(
          { provider, imageRef, templateRef, artifactRef },
        )}`,
      );
      return;
    }

    console.log(
      `[runComputeProvisioning] Provisioning succeeded ${JSON.stringify({
        provider,
        artifactRef,
      })}`,
    );

    await dispatchWaitingTasksForProvisioning(provider).catch((error) => {
      console.error(
        `[runComputeProvisioning] Provisioning succeeded but queued task dispatch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
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

    const failurePersisted = await db
      .transaction(async (tx) => {
        await acquireComputeProvisioningLock(provider, tx);
        const current = await getPersistedComputeProvisioning(provider, tx);

        if (
          !isCurrentComputeProvisioningAttempt(current, {
            imageRef,
            templateRef,
          })
        ) {
          console.warn(
            `[runComputeProvisioning] Ignoring superseded failed build ${JSON.stringify(
              { provider, imageRef, templateRef },
            )}`,
          );
          return false;
        }

        await persistComputeProvisioning(
          provider,
          {
            status: 'failed',
            runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
            imageRef,
            templateRef: null,
            error: message,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
          tx,
        );

        return true;
      })
      .catch((persistError) => {
        console.error(
          `[runComputeProvisioning] Failed to persist provisioning failure: ${
            persistError instanceof Error
              ? persistError.message
              : String(persistError)
          }`,
        );
        return false;
      });

    if (failurePersisted) {
      await failWaitingTasksForProvisioning(provider, message).catch(
        (taskError) => {
          console.error(
            `[runComputeProvisioning] Failed to publish provisioning failure to queued tasks: ${
              taskError instanceof Error ? taskError.message : String(taskError)
            }`,
          );
        },
      );
    }
  } finally {
    activeProvisioningClaims.delete(claimKey);
  }
}

/**
 * Reconciles Roomote-managed hosted artifacts at web-process startup. The
 * build itself remains detached: startup only records an idempotent pending
 * claim, and the old active artifact stays configured until the replacement
 * succeeds. Task creation therefore continues to use the last known-good
 * artifact during a rollout.
 */
export async function reconcileComputeProvisioningOnStartup(): Promise<void> {
  const [persistedEnvVarNames, persistedEnvVarValues] = await Promise.all([
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
    ]),
  ]);
  const status = buildSetupComputeStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    persistedEnvVarValues,
  });

  for (const provider of Object.keys(
    PROVISIONING_PROVIDERS,
  ) as SetupProvisionableComputeProvider[]) {
    try {
      const providerStatus = status.providers.find(
        (candidate) => candidate.provider === provider,
      );

      if (!providerStatus) continue;

      const credentialsAvailable = providerStatus.fields
        .filter(
          (field) =>
            field.category === 'credential' && field.required !== false,
        )
        .every((field) => field.runtimeSatisfied || field.savedSatisfied);

      if (!credentialsAvailable) continue;

      const start = await db.transaction(async (tx) => {
        // Multiple web replicas can start on the same release. Serialize the
        // read/claim transition so only one process records and launches the
        // deterministic provider build.
        await acquireComputeProvisioningLock(provider, tx);
        const existingState = await getPersistedComputeProvisioning(
          provider,
          tx,
        );
        const prepared = await prepareComputeProvisioningStart({
          provider,
          providerStatus,
          existingState,
          dockerWorkerImage: process.env.DOCKER_WORKER_IMAGE,
          runtimeEnv: process.env,
          markPending: (nextState) =>
            persistComputeProvisioning(provider, nextState, tx),
        });

        return prepared.start;
      });

      if (start) {
        void runComputeProvisioning({ userId: null, ...start });
      }
    } catch (error) {
      console.error(
        `[reconcileComputeProvisioningOnStartup] Failed to reconcile ${provider}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

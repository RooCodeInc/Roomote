import {
  CloudTaskType,
  NonRetryableSpawnError,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type CloudJob,
  createComputeProviderMutationEventRecorder,
  db,
  cloudJobs,
  eq,
} from '@roomote/db/server';
import { stampCloudJobMilestone } from '@roomote/sdk/server';
import {
  buildComputeProviderMutationDetails,
  buildDaytonaWorkerEnv,
  cleanupDaytonaInstance,
  createComputeProviderClient,
  createDaytonaMachine,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForCloudJob,
  shouldEnableAuthBypassForCloudJob,
  updateCloudJobMachine,
} from '../utils';

const DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT = 500;

class DetachedWorkerLaunchError extends Error {
  public readonly details: Record<string, unknown>;

  public constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'DetachedWorkerLaunchError';
    this.details = details;
  }
}

function truncateLaunchOutput(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, DAYTONA_LAUNCH_OUTPUT_TEXT_LIMIT)}...`
    : trimmed;
}

function buildDetachedWorkerExitError(result: {
  exitCode: number | null;
  commandId?: string;
  stdout?: string;
  stderr?: string;
}): DetachedWorkerLaunchError {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const message = `Detached "worker run" exited immediately with code ${result.exitCode}`;

  return new DetachedWorkerLaunchError(message, {
    commandId: result.commandId ?? null,
    exitCode: result.exitCode,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  });
}

export async function spawnDaytonaWorker(
  cloudJob: CloudJob,
  authToken: string,
  config: {
    daytonaApiKey: string;
    daytonaApiUrl?: string;
    daytonaTarget?: string;
    daytonaSnapshotName: string;
    daytonaTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    daytonaTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    daytonaApiKey,
    daytonaApiUrl,
    daytonaTarget,
    daytonaSnapshotName,
    daytonaTimeoutMs,
    localTarballPath,
    deploymentSlug,
    daytonaTags,
  } = config;

  // Daytona does not support environment or task snapshots yet, so snapshot
  // job types cannot run on this provider.
  if (
    cloudJob.type === CloudTaskType.SnapshotEnvironment ||
    cloudJob.type === CloudTaskType.SnapshotResume
  ) {
    throw new NonRetryableSpawnError(
      `Daytona provider does not support ${cloudJob.type} jobs`,
    );
  }

  const environmentId = cloudJob.payload.environmentId;

  const { namedPorts, environmentConfig } =
    await getNamedPortsForCloudJob(cloudJob);

  const shouldEnableAuthBypass = shouldEnableAuthBypassForCloudJob({
    environmentConfig,
    namedPorts,
  });

  const authBypassValue = shouldEnableAuthBypass
    ? resolveAuthBypassValue(environmentConfig)
    : undefined;

  const authBypassHeaderName = shouldEnableAuthBypass
    ? resolveAuthBypassHeaderName(environmentConfig)
    : undefined;

  console.log(
    `[spawnDaytonaWorker] Creating Daytona instance for job #${cloudJob.id}... ${JSON.stringify(
      {
        launchMode: 'fresh',
        namedPorts: namedPorts.map((p) => p.name),
      },
    )}`,
  );

  const createMachineStart = Date.now();

  const mutationContext = {
    launchMode: 'fresh',
    sourceSnapshotId: null,
    ports: namedPorts.map(({ port }) => port),
  } as const;

  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
    },
    { logPrefix: 'spawnDaytonaWorker', logger: console },
  );

  const computeClient = createComputeProviderClient({
    provider: 'daytona',
    config: {
      apiKey: daytonaApiKey,
      snapshotName: daytonaSnapshotName,
      ...(daytonaApiUrl ? { apiUrl: daytonaApiUrl } : {}),
      ...(daytonaTarget ? { target: daytonaTarget } : {}),
      timeoutMs: daytonaTimeoutMs,
    },
  });

  // Stamp provisionStartedAt + launchMode before the Daytona API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampCloudJobMilestone({
    cloudJobId: cloudJob.id,
    field: 'provisionStartedAt',
    launchMode: 'fresh',
  }).catch((error) => {
    console.warn(
      `[spawnDaytonaWorker] Failed to stamp provisionStartedAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createDaytonaMachine({
    daytonaApiKey,
    daytonaApiUrl,
    daytonaTarget,
    daytonaSnapshotName,
    namedPorts,
    tags: daytonaTags,
    timeoutMs: daytonaTimeoutMs,
    localTarballPath,
    createInstanceTimeoutMs: 180_000,
    bootstrapTimeoutMs: 120_000,
    computeClient,
    onMutation: recordMutation,
  });

  const args = ['run', cloudJob.id.toString()];

  try {
    await updateCloudJobMachine({
      cloudJob,
      vendor: 'daytona',
      machineId: machine.machineId,
      namedPorts,
      domainFn: (port) => machine.domain(port),
      proxyPorts: machine.proxyPorts ?? {},
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId: null,
      authBypassValue,
      authBypassHeaderName,
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampCloudJobMilestone({
      cloudJobId: cloudJob.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnDaytonaWorker] Failed to stamp provisionReadyAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: cloudJob.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'daytona',
        computeProviderId: machine.machineId,
        cloudJobId: cloudJob.id,
        context: 'Fresh Daytona launch',
      });
    }

    console.log(
      `[spawnDaytonaWorker] Daytona instance created for job #${cloudJob.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId },
      )}`,
    );

    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker run for Daytona instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
      }),
    });

    const result = await computeClient.runCommand({
      instanceId: machine.machineId,
      cmd: 'worker',
      args,
      env: buildDaytonaWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + daytonaTimeoutMs,
        deploymentSlug,
        environmentId,
        snapshotName: daytonaSnapshotName,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(daytonaTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(result);
    }

    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker run for Daytona instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        commandId: result.commandId ?? null,
        exitCode: result.exitCode,
      }),
    });

    if (result.commandId) {
      await db
        .update(cloudJobs)
        .set({ sandboxCmdId: result.commandId })
        .where(eq(cloudJobs.id, cloudJob.id));
    }

    return {
      machineId: machine.machineId,
      ...(result.commandId ? { sandboxCmdId: result.commandId } : {}),
    };
  } catch (error) {
    await recordMutation({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for Daytona instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupDaytonaInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnDaytonaWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}

import {
  CloudTaskType,
  NonRetryableSpawnError,
  resolveConfiguredComputeProviderResources,
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
  buildModalWorkerEnv,
  cleanupModalInstance,
  createComputeProviderClient,
  createModalMachine,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForCloudJob,
  shouldEnableAuthBypassForCloudJob,
  updateCloudJobMachine,
} from '../utils';

const MODAL_LAUNCH_OUTPUT_TEXT_LIMIT = 500;

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

  return trimmed.length > MODAL_LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, MODAL_LAUNCH_OUTPUT_TEXT_LIMIT)}...`
    : trimmed;
}

function buildDetachedWorkerExitError(
  command: string,
  result: {
    exitCode: number | null;
    commandId?: string;
    stdout?: string;
    stderr?: string;
  },
): DetachedWorkerLaunchError {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const message = `Detached "worker ${command}" exited immediately with code ${result.exitCode}`;
  const parts = [message];

  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }

  if (stdout) {
    parts.push(`stdout: ${stdout}`);
  }

  return new DetachedWorkerLaunchError(message, {
    commandId: result.commandId ?? null,
    exitCode: result.exitCode,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  });
}

function getWorkerLaunchCommand(
  cloudJob: CloudJob,
): 'snapshot' | 'resume' | 'run' {
  return cloudJob.type === CloudTaskType.SnapshotEnvironment
    ? 'snapshot'
    : cloudJob.type === CloudTaskType.SnapshotResume
      ? 'resume'
      : 'run';
}

function getWorkerLaunchArgs(cloudJob: CloudJob, machineId: string): string[] {
  const command = getWorkerLaunchCommand(cloudJob);

  return cloudJob.type === CloudTaskType.SnapshotEnvironment
    ? [
        'snapshot',
        '--cloud-job-id',
        cloudJob.id.toString(),
        '--environment-id',
        cloudJob.payload.environmentId ?? '',
        '--sandbox-id',
        machineId,
      ]
    : [command, cloudJob.id.toString()];
}

export async function spawnModalWorker(
  cloudJob: CloudJob,
  authToken: string,
  config: {
    modalTokenId: string;
    modalTokenSecret: string;
    modalEndpoint?: string;
    modalEnvironment?: string;
    modalAppName?: string;
    modalBaseImageRef: string;
    modalRegistryUsername?: string;
    modalRegistryPassword?: string;
    modalEcrOidcRoleArn?: string;
    modalEcrRegion?: string;
    modalTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    modalTags?: Record<string, string>;
  },
): Promise<{
  machineId: string;
  sandboxCmdId?: string;
}> {
  const {
    modalTokenId,
    modalTokenSecret,
    modalEndpoint,
    modalEnvironment,
    modalAppName,
    modalBaseImageRef,
    modalRegistryUsername,
    modalRegistryPassword,
    modalEcrOidcRoleArn,
    modalEcrRegion,
    modalTimeoutMs,
    localTarballPath,
    deploymentSlug,
    modalTags,
  } = config;
  const environmentId = cloudJob.payload.environmentId;

  const { namedPorts, environmentSnapshotId, environmentConfig } =
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

  let launchOptions:
    | { launchMode: 'fresh' }
    | { launchMode: 'environment_snapshot'; sourceSnapshotId: string }
    | { launchMode: 'task_snapshot'; sourceSnapshotId: string };

  if (cloudJob.type === CloudTaskType.SnapshotResume) {
    const snapshotId = cloudJob.sourceSnapshotId;

    if (!snapshotId) {
      throw new NonRetryableSpawnError(
        `SnapshotResume job #${cloudJob.id} missing sourceSnapshotId`,
      );
    }

    launchOptions = {
      launchMode: 'task_snapshot',
      sourceSnapshotId: snapshotId,
    };
  } else if (cloudJob.type === CloudTaskType.SnapshotEnvironment) {
    // Environment snapshot refreshes must rebuild from the configured base
    // image path instead of inheriting the previous environment snapshot.
    launchOptions = { launchMode: 'fresh' };
  } else {
    // For all other job types, any
    // available snapshot—whether persisted on the job or resolved from the
    // environment—is treated as a cached base image. The latest shipped
    // worker/runtime is reinstalled on top before work begins.
    const snapshotId =
      cloudJob.sourceSnapshotId ?? environmentSnapshotId ?? undefined;

    launchOptions = snapshotId
      ? { launchMode: 'environment_snapshot', sourceSnapshotId: snapshotId }
      : { launchMode: 'fresh' };
  }

  if (
    cloudJob.type === CloudTaskType.SnapshotEnvironment &&
    !cloudJob.payload.environmentId
  ) {
    throw new Error(
      `SnapshotEnvironment job #${cloudJob.id} missing environmentId in payload`,
    );
  }

  console.log(
    `[spawnModalWorker] Creating modal instance for job #${cloudJob.id}... ${JSON.stringify(
      {
        ...launchOptions,
        namedPorts: namedPorts.map((p) => p.name),
      },
    )}`,
  );

  const createMachineStart = Date.now();

  const mutationContext = {
    launchMode: launchOptions.launchMode,
    sourceSnapshotId:
      'sourceSnapshotId' in launchOptions
        ? launchOptions.sourceSnapshotId
        : null,
    ports: namedPorts.map(({ port }) => port),
  } as const;

  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
    },
    { logPrefix: 'spawnModalWorker', logger: console },
  );

  const configuredResources = resolveConfiguredComputeProviderResources({
    provider: 'modal',
  });

  const modalConfig = {
    tokenId: modalTokenId,
    tokenSecret: modalTokenSecret,
    baseImageRef: modalBaseImageRef,
    ...(modalEndpoint ? { endpoint: modalEndpoint } : {}),
    ...(modalEnvironment ? { environment: modalEnvironment } : {}),
    ...(modalAppName ? { appName: modalAppName } : {}),
    ...(modalRegistryUsername
      ? { registryUsername: modalRegistryUsername }
      : {}),
    ...(modalRegistryPassword
      ? { registryPassword: modalRegistryPassword }
      : {}),
    ...(modalEcrOidcRoleArn ? { ecrOidcRoleArn: modalEcrOidcRoleArn } : {}),
    ...(modalEcrRegion ? { ecrRegion: modalEcrRegion } : {}),
    ...(configuredResources.configuredCpuCores !== null
      ? { cpu: configuredResources.configuredCpuCores }
      : {}),
    ...(configuredResources.configuredMemoryMiB !== null
      ? { memoryMiB: configuredResources.configuredMemoryMiB }
      : {}),
    timeoutMs: modalTimeoutMs,
  };

  const computeClient = createComputeProviderClient({
    provider: 'modal',
    config: modalConfig,
  });

  // Stamp provisionStartedAt + launchMode before the Modal API call. Only-if-
  // null semantics preserve the earliest provision timestamp.
  await stampCloudJobMilestone({
    cloudJobId: cloudJob.id,
    field: 'provisionStartedAt',
    launchMode: launchOptions.launchMode,
  }).catch((error) => {
    console.warn(
      `[spawnModalWorker] Failed to stamp provisionStartedAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const machine = await createModalMachine({
    modalTokenId,
    modalTokenSecret,
    modalEndpoint,
    modalEnvironment,
    modalAppName,
    modalBaseImageRef,
    modalRegistryUsername,
    modalRegistryPassword,
    modalEcrOidcRoleArn,
    modalEcrRegion,
    namedPorts,
    tags: modalTags,
    timeoutMs: modalTimeoutMs,
    localTarballPath,
    createInstanceTimeoutMs: 180_000,
    bootstrapTimeoutMs: 120_000,
    computeClient,
    onMutation: recordMutation,
    ...launchOptions,
  });

  const command = getWorkerLaunchCommand(cloudJob);
  const args = getWorkerLaunchArgs(cloudJob, machine.machineId);

  try {
    await updateCloudJobMachine({
      cloudJob,
      vendor: 'modal',
      machineId: machine.machineId,
      namedPorts,
      domainFn: (port) => machine.domain(port),
      proxyPorts: machine.proxyPorts ?? {},
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId:
        'sourceSnapshotId' in launchOptions
          ? launchOptions.sourceSnapshotId
          : null,
      authBypassValue,
      authBypassHeaderName,
      ...configuredResources,
    });

    // Infrastructure is usable; worker.js hand-off follows.
    await stampCloudJobMilestone({
      cloudJobId: cloudJob.id,
      field: 'provisionReadyAt',
    }).catch((error) => {
      console.warn(
        `[spawnModalWorker] Failed to stamp provisionReadyAt for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: cloudJob.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'modal',
        computeProviderId: machine.machineId,
        cloudJobId: cloudJob.id,
        context: 'Fresh Modal launch',
      });
    }

    console.log(
      `[spawnModalWorker] Modal instance created for job #${cloudJob.id} in ${Date.now() - createMachineStart}ms ${JSON.stringify(
        { machineId: machine.machineId },
      )}`,
    );
    await recordMutation({
      provider: 'modal',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Calling runCommand to launch detached worker ${command} for Modal instance ${machine.machineId}.`,
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
      env: buildModalWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + modalTimeoutMs,
        deploymentSlug,
        environmentId,
        baseImageRef: modalBaseImageRef,
        extraEnv: {
          SANDBOX_TIMEOUT_MS: String(modalTimeoutMs),
        },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      throw buildDetachedWorkerExitError(command, result);
    }

    await recordMutation({
      provider: 'modal',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `runCommand launched detached worker ${command} for Modal instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        commandId: result.commandId ?? null,
        exitCode: result.exitCode,
      }),
    });

    if (!result.commandId) {
      console.warn(
        `[spawnModalWorker] Missing command ID for detached "worker ${command}" on job #${cloudJob.id}; startup log streaming is reduced for modal v1`,
      );
    }

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
      provider: 'modal',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: machine.machineId,
      message: `runCommand failed while launching detached worker for Modal instance ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        command: 'worker',
        args,
        detached: true,
        phase: 'launch_worker',
        ...(error instanceof DetachedWorkerLaunchError ? error.details : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    await cleanupModalInstance({
      computeClient,
      instanceId: machine.machineId,
      phase: 'spawn_worker',
      error,
      logPrefix: 'spawnModalWorker',
      onMutation: recordMutation,
      ...mutationContext,
    });
    throw error;
  }
}

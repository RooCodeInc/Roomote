import {
  NonRetryableSpawnError,
  TaskPayloadKind,
  getPrimaryPortFromConfig,
} from '@roomote/types';
import {
  type TaskRun,
  createComputeProviderMutationEventRecorder,
  db,
  eq,
  taskRuns,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildBlaxelWorkerEnv,
  buildComputeProviderMutationDetails,
  createBlaxelMachine,
  createComputeProviderClient,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import { primeEnvironmentOidcForMachine } from '../sandbox-oidc';
import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';

export async function spawnBlaxelWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    blaxelApiKey: string;
    blaxelWorkspace: string;
    blaxelImage: string;
    blaxelRegion?: string;
    blaxelTimeoutMs: number;
    localTarballPath?: string;
    deploymentSlug?: string;
    blaxelTags?: Record<string, string>;
  },
): Promise<{ machineId: string; sandboxCmdId?: string }> {
  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment ||
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume
  ) {
    throw new NonRetryableSpawnError(
      'Blaxel does not support Roomote environment snapshots',
    );
  }

  const { namedPorts, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);
  const authBypassEnabled = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });
  const authBypassValue = authBypassEnabled
    ? resolveAuthBypassValue(environmentConfig)
    : undefined;
  const authBypassHeaderName = authBypassEnabled
    ? resolveAuthBypassHeaderName(environmentConfig)
    : undefined;
  const environmentId = taskRun.payload.environmentId;
  const mutationContext = {
    launchMode: 'fresh' as const,
    sourceSnapshotId: null,
    ports: namedPorts.map(({ port }) => port),
  };
  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    { runId: taskRun.id, taskId: taskRun.taskId },
    { logPrefix: 'spawnBlaxelWorker', logger: console },
  );
  const computeClient = createComputeProviderClient({
    provider: 'blaxel',
    config: {
      apiKey: config.blaxelApiKey,
      workspace: config.blaxelWorkspace,
      image: config.blaxelImage,
      region: config.blaxelRegion,
      timeoutMs: config.blaxelTimeoutMs,
    },
  });

  await stampTaskRunMilestone({
    runId: taskRun.id,
    field: 'provisionStartedAt',
    launchMode: 'fresh',
  });
  const machine = await createBlaxelMachine({
    blaxelApiKey: config.blaxelApiKey,
    blaxelWorkspace: config.blaxelWorkspace,
    blaxelImage: config.blaxelImage,
    blaxelRegion: config.blaxelRegion,
    namedPorts,
    tags: config.blaxelTags,
    timeoutMs: config.blaxelTimeoutMs,
    localTarballPath: config.localTarballPath,
    createInstanceTimeoutMs: 180_000,
    bootstrapTimeoutMs: 120_000,
    computeClient,
    onMutation: recordMutation,
  });

  try {
    await updateTaskRunMachine({
      taskRun,
      vendor: 'blaxel',
      machineId: machine.machineId,
      namedPorts,
      domainFn: machine.domain,
      proxyPorts: machine.proxyPorts,
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sourceSnapshotId: null,
      authBypassValue,
      authBypassHeaderName,
    });
    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    });
    if (environmentId && environmentConfig) {
      await primeEnvironmentOidcForMachine({
        taskId: taskRun.taskId,
        environmentId,
        environmentConfig,
        computeProvider: 'blaxel',
        computeProviderId: machine.machineId,
        runId: taskRun.id,
        context: 'Fresh Blaxel launch',
      });
    }

    const args = ['run', taskRun.id.toString()];
    await recordMutation({
      provider: 'blaxel',
      operation: 'run_command',
      eventType: 'started',
      instanceId: machine.machineId,
      message: `Launching detached worker for Blaxel sandbox ${machine.machineId}.`,
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
      env: buildBlaxelWorkerEnv({
        authToken,
        sandboxExpiresAtMs: Date.now() + config.blaxelTimeoutMs,
        deploymentSlug: config.deploymentSlug,
        environmentId,
        image: config.blaxelImage,
        extraEnv: { SANDBOX_TIMEOUT_MS: String(config.blaxelTimeoutMs) },
      }),
      detached: true,
      signal: AbortSignal.timeout(60_000),
    });
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        `Detached Blaxel worker exited with code ${result.exitCode}: ${result.stderr ?? result.stdout ?? 'no output'}`,
      );
    }
    await recordMutation({
      provider: 'blaxel',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: machine.machineId,
      message: `Detached worker launched for Blaxel sandbox ${machine.machineId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        commandId: result.commandId ?? null,
        exitCode: result.exitCode,
      }),
    });
    if (result.commandId) {
      await db
        .update(taskRuns)
        .set({ sandboxCmdId: result.commandId })
        .where(eq(taskRuns.id, taskRun.id));
    }
    return {
      machineId: machine.machineId,
      ...(result.commandId ? { sandboxCmdId: result.commandId } : {}),
    };
  } catch (error) {
    await computeClient
      .destroyInstance({ instanceId: machine.machineId })
      .catch((cleanupError) => {
        console.error('[spawnBlaxelWorker] Cleanup failed', cleanupError);
      });
    throw error;
  }
}

import { Env } from '@roomote/env';
import {
  buildDockerWorkerEnv,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';
import { getPrimaryPortFromConfig, SANDBOX_SERVER_PORT } from '@roomote/types';
import { count, db, isNull, type TaskRun, users } from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import {
  launchRoomoteCloudCompute,
  stopRoomoteCloudCompute,
  type RoomoteCloudRuntimeConfig,
} from '../roomote-cloud-runtime';

async function stopLeaseBestEffort(
  cloudConfig: RoomoteCloudRuntimeConfig,
  leaseId: string,
): Promise<void> {
  await stopRoomoteCloudCompute(cloudConfig, leaseId).catch((cleanupError) => {
    console.error(
      `[spawnRoomoteCloudWorker] Failed to clean up lease ${leaseId}: ${
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError)
      }`,
    );
  });
}

export async function spawnRoomoteCloudWorker(input: {
  taskRun: TaskRun;
  authToken: string;
  deploymentSlug: string;
  timeoutMs: number;
  cloudConfig: RoomoteCloudRuntimeConfig;
}) {
  const [{ namedPorts, environmentConfig }, [activeUsers]] = await Promise.all([
    getNamedPortsForTaskRun(input.taskRun),
    db.select({ total: count() }).from(users).where(isNull(users.deletedAt)),
  ]);
  const shouldEnableAuthBypass = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });
  const workerEnv = {
    ...buildDockerWorkerEnv({
      authToken: input.authToken,
      sandboxExpiresAtMs: Date.now() + input.timeoutMs,
      deploymentSlug: input.deploymentSlug,
      environmentId: input.taskRun.payload.environmentId,
      image: 'roomote-cloud-managed',
      extraEnv: {
        SANDBOX_TIMEOUT_MS: String(input.timeoutMs),
        TRPC_URL: process.env.TRPC_URL ?? Env.TRPC_URL,
        R_APP_URL: process.env.R_APP_URL ?? Env.R_APP_URL,
        ROOMOTE_APP_URL: process.env.R_APP_URL ?? Env.R_APP_URL,
      },
    }),
    COMPUTE_PROVIDER: 'roomote-cloud',
    ROOMOTE_WORKER_COMPUTE_PROVIDER: 'roomote-cloud',
  };
  const lease = await launchRoomoteCloudCompute(input.cloudConfig, {
    runId: input.taskRun.id,
    taskId: String(input.taskRun.taskId),
    deploymentSlug: input.deploymentSlug,
    timeoutSeconds: Math.ceil(input.timeoutMs / 1000),
    activeSeatCount: activeUsers?.total ?? 0,
    environment: workerEnv,
    ports: namedPorts.map(({ port }) => port),
  });

  try {
    const sandboxPort = lease.proxyPorts[String(SANDBOX_SERVER_PORT)];
    const sandboxUrl =
      lease.portUrls?.[String(SANDBOX_SERVER_PORT)] ??
      (sandboxPort ? `http://127.0.0.1:${sandboxPort}` : undefined);
    if (!sandboxUrl) {
      throw new Error(
        'Roomote Cloud compute lease omitted the sandbox server port',
      );
    }

    const attached = await updateTaskRunMachine(
      {
        taskRun: input.taskRun,
        vendor: 'roomote-cloud',
        machineId: lease.id,
        namedPorts,
        domainFn: (port) => {
          const hostedUrl = lease.portUrls?.[String(port)];
          if (hostedUrl) {
            return hostedUrl;
          }
          const published = lease.proxyPorts[String(port)];
          if (!published) {
            throw new Error(`Roomote Cloud compute lease omitted port ${port}`);
          }
          return `http://127.0.0.1:${published}`;
        },
        explicitPrimaryPortName: getPrimaryPortFromConfig(
          environmentConfig?.ports,
        )?.name,
        sandboxServerUrl: sandboxUrl,
        authBypassValue: shouldEnableAuthBypass
          ? resolveAuthBypassValue(environmentConfig)
          : undefined,
        authBypassHeaderName: shouldEnableAuthBypass
          ? resolveAuthBypassHeaderName(environmentConfig)
          : undefined,
        sourceSnapshotId: null,
      },
      { onlyIfNotCanceled: true },
    );
    if (!attached) {
      await stopLeaseBestEffort(input.cloudConfig, lease.id);
      return;
    }
    await stampTaskRunMilestone({
      runId: input.taskRun.id,
      field: 'provisionReadyAt',
    });
    return lease;
  } catch (error) {
    await stopLeaseBestEffort(input.cloudConfig, lease.id);
    throw error;
  }
}

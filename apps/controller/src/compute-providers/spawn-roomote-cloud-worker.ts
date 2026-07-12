import { Env } from '@roomote/env';
import {
  buildDockerWorkerEnv,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';
import { getPrimaryPortFromConfig, SANDBOX_SERVER_PORT } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import {
  launchRoomoteCloudCompute,
  type RoomoteCloudRuntimeConfig,
} from '../roomote-cloud-runtime';
import { toContainerReachableUrl } from './spawn-docker-worker';

export async function spawnRoomoteCloudWorker(input: {
  taskRun: TaskRun;
  authToken: string;
  deploymentSlug: string;
  timeoutMs: number;
  cloudConfig: RoomoteCloudRuntimeConfig;
  managedRuntimeEnv: Record<string, string>;
}) {
  const { namedPorts, environmentConfig } = await getNamedPortsForTaskRun(
    input.taskRun,
  );
  const shouldEnableAuthBypass = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });
  const workerEnv = buildDockerWorkerEnv({
    authToken: input.authToken,
    sandboxExpiresAtMs: Date.now() + input.timeoutMs,
    deploymentSlug: input.deploymentSlug,
    environmentId: input.taskRun.payload.environmentId,
    image: 'roomote-cloud-managed',
    extraEnv: {
      ...input.managedRuntimeEnv,
      SANDBOX_TIMEOUT_MS: String(input.timeoutMs),
      TRPC_URL: toContainerReachableUrl(process.env.TRPC_URL ?? Env.TRPC_URL),
      R_APP_URL: toContainerReachableUrl(
        process.env.R_APP_URL ?? Env.R_APP_URL,
      ),
      ROOMOTE_APP_URL: toContainerReachableUrl(
        process.env.R_APP_URL ?? Env.R_APP_URL,
      ),
    },
  });
  const lease = await launchRoomoteCloudCompute(input.cloudConfig, {
    runId: input.taskRun.id,
    taskId: String(input.taskRun.taskId),
    deploymentSlug: input.deploymentSlug,
    timeoutSeconds: Math.ceil(input.timeoutMs / 1000),
    environment: workerEnv,
    ports: namedPorts.map(({ port }) => port),
  });
  const sandboxPort = lease.proxyPorts[String(SANDBOX_SERVER_PORT)];
  const sandboxUrl =
    lease.portUrls?.[String(SANDBOX_SERVER_PORT)] ??
    (sandboxPort ? `http://127.0.0.1:${sandboxPort}` : undefined);
  if (!sandboxUrl)
    throw new Error(
      'Roomote Cloud compute lease omitted the sandbox server port',
    );

  await updateTaskRunMachine({
    taskRun: input.taskRun,
    vendor: lease.provider === 'e2b' ? 'e2b' : 'docker',
    machineId: lease.machineId,
    namedPorts,
    domainFn: (port) => {
      const hostedUrl = lease.portUrls?.[String(port)];
      if (hostedUrl) return hostedUrl;
      const published = lease.proxyPorts[String(port)];
      if (!published)
        throw new Error(`Roomote Cloud compute lease omitted port ${port}`);
      return `http://127.0.0.1:${published}`;
    },
    explicitPrimaryPortName: getPrimaryPortFromConfig(environmentConfig?.ports)
      ?.name,
    sandboxServerUrl: sandboxUrl,
    authBypassValue: shouldEnableAuthBypass
      ? resolveAuthBypassValue(environmentConfig)
      : undefined,
    authBypassHeaderName: shouldEnableAuthBypass
      ? resolveAuthBypassHeaderName(environmentConfig)
      : undefined,
    sourceSnapshotId: null,
  });
  await stampTaskRunMilestone({
    runId: input.taskRun.id,
    field: 'provisionReadyAt',
  });
  return lease;
}

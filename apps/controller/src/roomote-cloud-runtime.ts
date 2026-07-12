type RoomoteCloudRuntimeSession = {
  reservationId: string;
  token: string;
  expiresInSeconds: number;
  inference: {
    baseUrl: string;
    defaultModel: string;
    availableModels: string[];
  };
};

export type RoomoteCloudRuntimeConfig = {
  baseUrl: string;
  deploymentToken: string;
};

type RoomoteCloudComputeLease = {
  id: string;
  provider: 'docker';
  machineId: string;
  status: 'ready';
  proxyPorts: Record<string, number>;
  expiresAt: string;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function readRoomoteCloudRuntimeConfig(
  env: NodeJS.ProcessEnv,
): RoomoteCloudRuntimeConfig | null {
  const values = {
    baseUrl: env.ROOMOTE_CLOUD_URL?.trim(),
    deploymentToken: env.ROOMOTE_CLOUD_DEPLOYMENT_TOKEN?.trim(),
  };
  const configured = Object.values(values).filter(Boolean).length;

  if (configured === 0) return null;
  if (configured !== 2) {
    throw new Error(
      'Roomote Cloud runtime config is partial; set ROOMOTE_CLOUD_URL and ROOMOTE_CLOUD_DEPLOYMENT_TOKEN together',
    );
  }

  return {
    baseUrl: normalizeBaseUrl(values.baseUrl!),
    deploymentToken: values.deploymentToken!,
  };
}

export async function acquireRoomoteCloudRuntime(
  config: RoomoteCloudRuntimeConfig,
  input: { taskId: string; runId: number; expiresInSeconds: number },
  fetchFn: typeof fetch = fetch,
): Promise<{ reservationId: string; workerEnv: Record<string, string> }> {
  const response = await fetchFn(`${config.baseUrl}/runtime/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.deploymentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: input.taskId,
      runId: input.runId,
      expiresInSeconds: Math.min(7200, Math.max(60, input.expiresInSeconds)),
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Roomote Cloud runtime admission failed (${response.status}): ${detail}`,
    );
  }

  const session = (await response.json()) as RoomoteCloudRuntimeSession;
  if (!session.token || !session.reservationId || !session.inference?.baseUrl) {
    throw new Error('Roomote Cloud returned an invalid runtime session');
  }

  return {
    reservationId: session.reservationId,
    workerEnv: {
      R_MODEL: session.inference.defaultModel,
      R_SMALL_MODEL: session.inference.defaultModel,
      ROOMOTE_CLOUD_INFERENCE_BASE_URL: session.inference.baseUrl,
      ROOMOTE_CLOUD_INFERENCE_TOKEN: session.token,
      ROOMOTE_CLOUD_SESSION_URL: config.baseUrl,
      ROOMOTE_CLOUD_RESERVATION_ID: session.reservationId,
    },
  };
}

export async function launchRoomoteCloudCompute(
  config: RoomoteCloudRuntimeConfig,
  input: {
    runId: number;
    taskId: string;
    deploymentSlug: string;
    timeoutSeconds: number;
    environment: Record<string, string>;
    ports: number[];
  },
  fetchFn: typeof fetch = fetch,
): Promise<RoomoteCloudComputeLease> {
  const response = await fetchFn(
    `${config.baseUrl}/runtime/v1/compute/leases`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.deploymentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Roomote Cloud compute launch failed (${response.status}): ${detail}`,
    );
  }
  const lease = (await response.json()) as RoomoteCloudComputeLease;
  if (!lease.machineId || lease.status !== 'ready')
    throw new Error('Roomote Cloud returned an invalid compute lease');
  return lease;
}

export type RoomoteCloudRuntimeConfig = {
  baseUrl: string;
  deploymentToken: string;
};

type RoomoteCloudComputeLease = {
  id: string;
  provider: 'roomote-cloud';
  status: 'ready';
  proxyPorts: Record<string, number>;
  portUrls?: Record<string, string>;
  expiresAt: string;
};

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('ROOMOTE_CLOUD_URL must use HTTPS.');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}

export function readRoomoteCloudRuntimeConfig(
  env: Partial<Record<string, string | undefined>>,
): RoomoteCloudRuntimeConfig | null {
  const values = {
    baseUrl: env.ROOMOTE_CLOUD_URL?.trim(),
    deploymentToken: env.ROOMOTE_CLOUD_DEPLOYMENT_TOKEN?.trim(),
  };
  const configured = Object.values(values).filter(Boolean).length;

  if (configured === 0) {
    return null;
  }
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

export async function launchRoomoteCloudCompute(
  config: RoomoteCloudRuntimeConfig,
  input: {
    runId: number;
    taskId: string;
    deploymentSlug: string;
    timeoutSeconds: number;
    activeSeatCount: number;
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
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Roomote Cloud compute launch failed (HTTP ${response.status}).`,
    );
  }
  const lease = (await response.json()) as RoomoteCloudComputeLease;
  if (
    !lease.id ||
    lease.provider !== 'roomote-cloud' ||
    lease.status !== 'ready' ||
    !lease.proxyPorts ||
    typeof lease.proxyPorts !== 'object'
  ) {
    throw new Error('Roomote Cloud returned an invalid compute lease');
  }
  return lease;
}

export async function stopRoomoteCloudCompute(
  config: RoomoteCloudRuntimeConfig,
  leaseId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(
    `${config.baseUrl}/runtime/v1/compute/leases/${encodeURIComponent(leaseId)}/stop`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.deploymentToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Roomote Cloud lease stop failed (HTTP ${response.status}).`,
    );
  }
}

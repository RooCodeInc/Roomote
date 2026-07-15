import { resolveDeploymentEnvVar } from '@roomote/db/server';
import { isRoomoteCloudEnabled } from '@roomote/types';

export type RoomoteCloudRuntimeConfig = {
  baseUrl: string;
  deploymentToken: string;
};

type GitHubTokenResponse = {
  token: string;
  expiresAt: string;
};

function normalizeCloudBaseUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('ROOMOTE_CLOUD_URL must use HTTPS.');
  }

  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

export async function resolveRoomoteCloudRuntimeConfig(): Promise<RoomoteCloudRuntimeConfig | null> {
  const [enabledValue, baseUrl, deploymentToken] = await Promise.all([
    resolveDeploymentEnvVar('ROOMOTE_CLOUD_ENABLED'),
    resolveDeploymentEnvVar('ROOMOTE_CLOUD_URL'),
    resolveDeploymentEnvVar('ROOMOTE_CLOUD_DEPLOYMENT_TOKEN'),
  ]);

  if (
    !isRoomoteCloudEnabled({ ROOMOTE_CLOUD_ENABLED: enabledValue ?? undefined })
  ) {
    return null;
  }

  if (!baseUrl && !deploymentToken) {
    return null;
  }

  if (!baseUrl || !deploymentToken) {
    throw new Error(
      'ROOMOTE_CLOUD_URL and ROOMOTE_CLOUD_DEPLOYMENT_TOKEN must be configured together.',
    );
  }

  return {
    baseUrl: normalizeCloudBaseUrl(baseUrl),
    deploymentToken,
  };
}

export async function createRoomoteCloudGitHubToken(input: {
  config: RoomoteCloudRuntimeConfig;
  installationId: number;
  repositoryIds?: number[];
  fetchFn?: typeof fetch;
}): Promise<GitHubTokenResponse> {
  const endpoint = new URL(
    '/runtime/v1/integrations/github/token',
    input.config.baseUrl,
  );
  const response = await (input.fetchFn ?? fetch)(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.config.deploymentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      installationId: String(input.installationId),
      ...(input.repositoryIds?.length
        ? { repositoryIds: input.repositoryIds }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Roomote Cloud could not mint a GitHub installation token (HTTP ${response.status}).`,
    );
  }

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { token?: unknown }).token !== 'string' ||
    typeof (body as { expiresAt?: unknown }).expiresAt !== 'string'
  ) {
    throw new Error('Roomote Cloud returned an invalid GitHub token response.');
  }

  return body as GitHubTokenResponse;
}

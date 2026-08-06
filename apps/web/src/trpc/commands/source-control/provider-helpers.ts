import { isLoopbackHostname } from '@roomote/types';

import { Env } from '@/lib/server/env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';

export function getSourceControlWebhookUrl(
  provider: 'gitlab' | 'gitea' | 'bitbucket' | 'ado',
): string | null {
  // Match GitHub webhook URL selection: prefer TRPC_URL, but fall back to
  // getPublicAppUrl (R_PUBLIC_URL ?? R_APP_URL) when TRPC_URL is loopback so
  // self-hosted fleets with a public edge still register reachable webhooks.
  const trpcUrl = new URL(Env.TRPC_URL);
  const webhookBaseUrl = isLoopbackHostname(trpcUrl.hostname)
    ? getPublicAppUrl(Env)
    : Env.TRPC_URL;

  if (isLoopbackHostname(new URL(webhookBaseUrl).hostname)) {
    return null;
  }

  return new URL(`/api/webhooks/${provider}`, webhookBaseUrl).toString();
}

export function getAdoProjectId(permissions: unknown): string | null {
  if (typeof permissions !== 'object' || permissions === null) {
    return null;
  }

  const projectId = (permissions as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' && projectId.trim() ? projectId : null;
}

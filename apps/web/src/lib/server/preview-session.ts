import { createPreviewToken } from '@roomote/auth';
import {
  db,
  eq,
  resolveEffectivePreviewRuntimeConfig,
  taskRuns,
} from '@roomote/db/server';

import { getSignedInAuthContext } from '@/lib/server';
import { Env } from './env';

interface PreviewSession {
  enableHiDpi: boolean;
  httpUrl: string;
  resizeMode: 'remote';
  viewOnly: boolean;
  wsUrl: string;
}

export class PreviewSessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewSessionError';
  }
}

function validateRunId(runId: string): number {
  if (!/^\d+$/.test(runId)) {
    throw new PreviewSessionError(400, 'Invalid task run ID format');
  }

  return parseInt(runId, 10);
}

function parsePreviewUrl(previewUrl: string): URL {
  try {
    return new URL(previewUrl);
  } catch {
    throw new PreviewSessionError(400, 'Invalid preview URL format');
  }
}

async function validatePreviewUrlDomain(previewUrl: URL): Promise<void> {
  const resolvedPreviewRuntimeConfig =
    await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.PREVIEW_DOMAINS,
    });
  const previewDomainsRaw =
    resolvedPreviewRuntimeConfig.effective.previewDomains;

  if (!previewDomainsRaw) {
    console.error('PREVIEW_DOMAINS environment variable is not configured');
    throw new PreviewSessionError(500, 'Service misconfigured');
  }

  const previewDomains = previewDomainsRaw
    .split(',')
    .map((domain) => domain.trim().split(':')[0])
    .filter(Boolean);

  const isValidDomain = previewDomains.some(
    (domain) =>
      previewUrl.hostname === domain ||
      previewUrl.hostname.endsWith(`.${domain}`),
  );

  if (!isValidDomain) {
    throw new PreviewSessionError(400, 'Invalid preview URL domain');
  }
}

function buildPreviewWebSocketUrl(previewUrl: URL, token: string): string {
  const wsUrl = new URL('/websockify', previewUrl);
  wsUrl.protocol = previewUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('__preview_token', token);
  return wsUrl.toString();
}

export async function createPreviewSession(params: {
  runId: string;
  previewUrl: string;
}): Promise<PreviewSession> {
  const previewUrl = parsePreviewUrl(params.previewUrl);
  const runId = validateRunId(params.runId);

  await validatePreviewUrlDomain(previewUrl);

  const authResult = await getSignedInAuthContext();

  if (!authResult.success) {
    throw new PreviewSessionError(401, 'Unauthorized');
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    throw new PreviewSessionError(404, 'Task run not found or access denied');
  }

  const token = await createPreviewToken({
    userId: authResult.userId,
    timeoutSeconds: Env.PREVIEW_TOKEN_TTL_SECONDS,
  });

  return {
    enableHiDpi: previewUrl.searchParams.get('enable_hidpi') === 'true',
    httpUrl: (() => {
      const httpUrl = new URL(previewUrl.toString());
      httpUrl.searchParams.set('__preview_token', token);
      return httpUrl.toString();
    })(),
    resizeMode: 'remote',
    viewOnly: previewUrl.searchParams.get('view_only') === 'true',
    wsUrl: buildPreviewWebSocketUrl(previewUrl, token),
  };
}

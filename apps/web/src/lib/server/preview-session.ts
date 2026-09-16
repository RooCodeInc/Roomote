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

export interface DesktopStreamSession {
  configUrl: string;
  controlUrl: string;
  metricsUrl: string;
  streamUrl: string;
  telemetryUrl: string;
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

function buildPreviewResourceUrl(
  previewUrl: URL,
  path: string,
  token: string,
  websocket = false,
): string {
  const resourceUrl = new URL(path, previewUrl);
  if (websocket) {
    resourceUrl.protocol = previewUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  resourceUrl.searchParams.set('__preview_token', token);
  return resourceUrl.toString();
}

async function authorizePreviewSession(params: {
  runId: string;
  previewUrl: string;
}): Promise<{ previewUrl: URL; token: string }> {
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

  return { previewUrl, token };
}

export async function createPreviewSession(params: {
  runId: string;
  previewUrl: string;
}): Promise<PreviewSession> {
  const { previewUrl, token } = await authorizePreviewSession(params);

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

export async function createDesktopStreamSession(params: {
  runId: string;
  previewUrl: string;
}): Promise<DesktopStreamSession> {
  const { previewUrl, token } = await authorizePreviewSession(params);
  return {
    configUrl: buildPreviewResourceUrl(previewUrl, '/config', token),
    controlUrl: buildPreviewResourceUrl(previewUrl, '/control', token, true),
    metricsUrl: buildPreviewResourceUrl(previewUrl, '/metrics', token),
    streamUrl: buildPreviewResourceUrl(previewUrl, '/stream.mp4', token),
    telemetryUrl: buildPreviewResourceUrl(previewUrl, '/telemetry', token),
  };
}

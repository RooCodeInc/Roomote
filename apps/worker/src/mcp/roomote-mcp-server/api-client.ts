import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';
import type { TaskArtifactType } from '@roomote/types';

import type {
  ArtifactConfig,
  ArtifactMetadata,
  CreateArtifactResponse,
  DownloadUrlResponse,
  ListArtifactsResponse,
} from './types.js';

// Ceiling on any single platform-API request from the sandbox. These calls run
// inside an MCP tool invocation, which nothing else bounds: OpenCode waits on
// the tool indefinitely, so a request that never gets a response (API instance
// stall, half-open connection through a restart) wedges the whole task in a
// silently "running" turn until a human intervenes. A bounded failure surfaces
// as a normal tool error the agent can retry; the ceiling is deliberately
// generous so slow-but-alive operations (PR creation against a provider API)
// are never killed.
const DEFAULT_PLATFORM_API_TIMEOUT_MS = 120_000;
// Artifact/S3 transfers move real payloads (screenshots, videos), so give them
// a wider window than control-plane calls before declaring the transfer dead.
export const ARTIFACT_TRANSFER_TIMEOUT_MS = 600_000;

export function resolvePlatformApiTimeoutMs(): number {
  const raw = process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS?.trim();

  if (!raw) {
    return DEFAULT_PLATFORM_API_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PLATFORM_API_TIMEOUT_MS;
}

/**
 * `fetch` with a hard deadline. Composes with any caller-provided signal, and
 * translates the deadline expiry into a retryable error message instead of a
 * bare AbortError. The timeout signal also bounds body reads started within
 * the window (undici ties the response stream to the request signal).
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  context: { label: string; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = context.timeoutMs ?? resolvePlatformApiTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error(
        `${context.label}: no response from the Roomote API within ${timeoutMs}ms; the request was aborted and is safe to retry.`,
      );
    }

    throw error;
  }
}

export function buildApiHeaders(
  config: Pick<
    ArtifactConfig,
    'token' | 'authBypassHeaderName' | 'authBypassHeaderValue'
  >,
  headers: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    ...headers,
  };

  if (config.authBypassHeaderValue) {
    result[config.authBypassHeaderName ?? DEFAULT_AUTH_BYPASS_HEADER_NAME] =
      config.authBypassHeaderValue;
  }

  return result;
}

/**
 * Parse an error response from the API. Tries JSON first, falls back to
 * raw text.
 */
export async function parseApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { error?: string };
    return json.error ?? text;
  } catch {
    return text;
  }
}

/**
 * Step 1: Create an artifact record via the API.
 */
export async function createArtifactRecord(
  config: ArtifactConfig,
  params: {
    taskId: string;
    path: string;
    artifactType: TaskArtifactType;
    contentType: string;
    size: number;
  },
): Promise<CreateArtifactResponse> {
  const artifactType = params.artifactType;
  const createPath =
    artifactType === 'plan'
      ? '/api/artifacts/plan'
      : artifactType === 'visual-proof'
        ? '/api/artifacts/visual-proof'
        : '/api/artifacts';
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}${createPath}`,
    {
      method: 'POST',
      headers: buildApiHeaders(config, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(params),
    },
    { label: 'Failed to create artifact' },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(`Failed to create artifact: ${response.status} ${error}`);
  }

  return (await response.json()) as CreateArtifactResponse;
}

/**
 * Step 2: Upload content to a presigned S3 URL.
 */
export async function uploadToPresignedUrl(
  uploadUrl: string,
  content: Buffer,
  contentType: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': content.length.toString(),
      },
      body: new Uint8Array(content),
    },
    {
      label: 'Failed to upload to S3',
      timeoutMs: ARTIFACT_TRANSFER_TIMEOUT_MS,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to upload to S3: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.headers.get('etag')) {
    throw new Error(
      'Failed to upload to S3: successful response did not include an ETag',
    );
  }
}

/**
 * Step 3: Confirm upload completion.
 */
export async function confirmUpload(
  config: ArtifactConfig,
  artifactId: string,
  taskId: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/artifacts/${encodeURIComponent(artifactId)}/upload_complete?taskId=${encodeURIComponent(taskId)}`,
    {
      method: 'POST',
      headers: buildApiHeaders(config),
    },
    { label: 'Failed to confirm upload' },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to confirm upload: ${response.status} ${response.statusText}`,
    );
  }
}

/**
 * Full 3-step upload flow: create record → upload to S3 → confirm.
 */
export async function uploadArtifact(
  config: ArtifactConfig,
  params: {
    taskId: string;
    path: string;
    artifactType: TaskArtifactType;
    contentType: string;
    content: Buffer;
  },
): Promise<{
  artifactId: string;
  version: number;
  viewUrl: string;
  artifactType: TaskArtifactType;
  rawUrl?: string;
}> {
  const record = await createArtifactRecord(config, {
    taskId: params.taskId,
    path: params.path,
    artifactType: params.artifactType,
    contentType: params.contentType,
    size: params.content.length,
  });

  await uploadToPresignedUrl(
    record.uploadUrl,
    params.content,
    params.contentType,
  );
  await confirmUpload(config, record.id, params.taskId);

  return {
    artifactId: record.id,
    version: record.version,
    viewUrl: record.viewUrl,
    artifactType: record.artifactType,
    ...(record.rawUrl && { rawUrl: record.rawUrl }),
  };
}

/**
 * Fetch artifact metadata by task ID + path (and optionally version).
 */
export async function fetchArtifactMetadata(
  config: ArtifactConfig,
  params: { taskId: string; path: string; version?: number },
): Promise<ArtifactMetadata> {
  const encodedPath = params.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const versionQuery =
    params.version !== undefined ? `?v=${params.version}` : '';

  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/tasks/${encodeURIComponent(params.taskId)}/artifacts/${encodedPath}${versionQuery}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
    { label: 'Failed to fetch artifact metadata' },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(
      `Failed to fetch artifact metadata: ${response.status} ${error}`,
    );
  }

  return (await response.json()) as ArtifactMetadata;
}

/**
 * List a task's uploaded artifacts (latest version per path), optionally
 * filtered by artifact type.
 */
export async function listArtifacts(
  config: ArtifactConfig,
  params: { taskId: string; artifactType?: TaskArtifactType },
): Promise<ListArtifactsResponse> {
  const typeQuery = params.artifactType
    ? `?artifactType=${encodeURIComponent(params.artifactType)}`
    : '';

  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/tasks/${encodeURIComponent(params.taskId)}/artifacts${typeQuery}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
    { label: 'Failed to list artifacts' },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(`Failed to list artifacts: ${response.status} ${error}`);
  }

  return (await response.json()) as ListArtifactsResponse;
}

/**
 * Get a presigned download URL for an artifact.
 */
export async function getDownloadUrl(
  config: ArtifactConfig,
  artifactId: string,
  taskId: string,
): Promise<DownloadUrlResponse> {
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/artifacts/${encodeURIComponent(artifactId)}/url?taskId=${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
    { label: 'Failed to get download URL' },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(`Failed to get download URL: ${response.status} ${error}`);
  }

  return (await response.json()) as DownloadUrlResponse;
}

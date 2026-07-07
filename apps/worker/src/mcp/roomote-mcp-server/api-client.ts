import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';
import type { TaskArtifactType } from '@roomote/types';

import type {
  ArtifactConfig,
  ArtifactMetadata,
  CreateArtifactResponse,
  DownloadUrlResponse,
  ListArtifactsResponse,
} from './types.js';

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
  const response = await fetch(`${config.platformApiUrl}${createPath}`, {
    method: 'POST',
    headers: buildApiHeaders(config, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(params),
  });

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
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': content.length.toString(),
    },
    body: new Uint8Array(content),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload to S3: ${response.status} ${response.statusText}`,
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
  const response = await fetch(
    `${config.platformApiUrl}/api/artifacts/${encodeURIComponent(artifactId)}/upload_complete?taskId=${encodeURIComponent(taskId)}`,
    {
      method: 'POST',
      headers: buildApiHeaders(config),
    },
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

  const response = await fetch(
    `${config.platformApiUrl}/api/tasks/${encodeURIComponent(params.taskId)}/artifacts/${encodedPath}${versionQuery}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
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

  const response = await fetch(
    `${config.platformApiUrl}/api/tasks/${encodeURIComponent(params.taskId)}/artifacts${typeQuery}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
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
  const response = await fetch(
    `${config.platformApiUrl}/api/artifacts/${encodeURIComponent(artifactId)}/url?taskId=${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      headers: buildApiHeaders(config),
    },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(`Failed to get download URL: ${response.status} ${error}`);
  }

  return (await response.json()) as DownloadUrlResponse;
}

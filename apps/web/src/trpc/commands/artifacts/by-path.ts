import type { ArtifactWithContent } from '@/types';
import type { UserAuthSuccess } from '@/types';
import {
  getArtifactByPath as getArtifactByPathServer,
  generateDownloadUrl,
  signArtifactId,
  currentEpochSeconds,
} from '@/lib/server';

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024; // 1MB

async function readTextWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return undefined;
    }
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return undefined;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

export async function getArtifactByPathCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; path: string; version?: number },
): Promise<ArtifactWithContent | null> {
  const { taskId, path, version } = input;

  const artifact = await getArtifactByPathServer({
    taskId,
    path,
    version,
    auth: { userId: auth.userId, isAdmin: auth.isAdmin },
  });

  if (!artifact || !artifact.uploaded) {
    return null;
  }

  const downloadUrl = await generateDownloadUrl(
    artifact.taskId,
    artifact.id,
    artifact.path,
    artifact.version,
  );

  let content: string | undefined;

  const textBasedApplicationTypes = new Set([
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
    'application/toml',
    'application/x-toml',
    'application/x-sh',
    'application/sql',
    'application/graphql',
    'application/xhtml+xml',
    'application/x-httpd-php',
  ]);

  const isTextBased =
    artifact.contentType.startsWith('text/') ||
    artifact.contentType.includes('markdown') ||
    artifact.contentType.includes('+xml') ||
    artifact.contentType.includes('+json') ||
    textBasedApplicationTypes.has(artifact.contentType);

  if (isTextBased && artifact.size <= MAX_TEXT_PREVIEW_BYTES) {
    try {
      const response = await fetch(downloadUrl);

      if (response.ok) {
        content = await readTextWithByteLimit(response, MAX_TEXT_PREVIEW_BYTES);
      }
    } catch (error) {
      console.error('Failed to fetch artifact content:', error);
    }
  }

  // Generate a public raw URL for allowlisted artifact types
  const isImage = artifact.contentType.startsWith('image/');
  let rawUrl: string | undefined;
  if (isImage) {
    const ts = currentEpochSeconds();
    const sig = signArtifactId(artifact.id, ts);
    rawUrl = `/api/artifacts/${artifact.id}/raw?sig=${sig}&ts=${ts}`;
  }

  return {
    id: artifact.id,
    taskId: artifact.taskId,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType,
    contentType: artifact.contentType,
    size: artifact.size,
    createdAt: artifact.createdAt,
    downloadUrl,
    content,
    rawUrl,
  };
}

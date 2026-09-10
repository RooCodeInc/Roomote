import type { ArtifactWithContent } from '@/types';
import type { UserAuthSuccess } from '@/types';
import {
  getArtifactByPath as getArtifactByPathServer,
  getArtifactBySessionPath,
  generateDownloadUrl,
  generateOwnedDownloadUrl,
  signArtifactId,
  currentEpochSeconds,
} from '@/lib/server';
import { findReadableSession } from '@/lib/server/sessions';

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024; // 1MB
const MAX_THUMBNAIL_PREVIEW_BYTES = 1024;

async function readTextWithByteLimit(
  response: Response,
  maxBytes: number,
  truncate = false,
): Promise<string | undefined> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      !truncate &&
      Number.isFinite(contentLength) &&
      contentLength > maxBytes
    ) {
      return undefined;
    }
  }

  if (!response.body) {
    const text = await response.text();
    return truncate ? text.slice(0, maxBytes) : text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remainingBytes = maxBytes - totalBytes;
    if (value.byteLength > remainingBytes) {
      if (truncate && remainingBytes > 0) {
        chunks.push(value.subarray(0, remainingBytes));
        totalBytes += remainingBytes;
      }
      await reader.cancel();
      if (!truncate) return undefined;
      break;
    }

    chunks.push(value);
    totalBytes += value.byteLength;
    if (truncate && totalBytes === maxBytes) {
      await reader.cancel();
      break;
    }
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
  input: {
    taskId?: string;
    sessionId?: string;
    path: string;
    version?: number;
    preview?: boolean;
  },
): Promise<ArtifactWithContent | null> {
  const { taskId, sessionId, path, version, preview = false } = input;
  if (
    sessionId &&
    !(await findReadableSession(
      { userId: auth.userId, isAdmin: auth.isAdmin },
      sessionId,
    ))
  ) {
    return null;
  }

  const artifact = taskId
    ? await getArtifactByPathServer({
        taskId,
        path,
        version,
        auth: { userId: auth.userId, isAdmin: auth.isAdmin },
      })
    : sessionId
      ? await getArtifactBySessionPath({
          sessionId,
          path,
          version,
          auth: { userId: auth.userId, isAdmin: auth.isAdmin },
        })
      : null;

  if (!artifact || !artifact.uploaded) {
    return null;
  }

  const downloadUrl = artifact.taskId
    ? await generateDownloadUrl(
        artifact.taskId,
        artifact.id,
        artifact.path,
        artifact.version,
      )
    : await generateOwnedDownloadUrl(
        { sessionId: artifact.sessionId! },
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
  const normalizedContentType =
    artifact.contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = artifact.path.split('.').pop()?.toLowerCase();
  const hasHtmlExtension =
    extension === 'html' || extension === 'htm' || extension === 'xhtml';

  const isTextBased =
    normalizedContentType.startsWith('text/') ||
    normalizedContentType.includes('markdown') ||
    normalizedContentType.includes('+xml') ||
    normalizedContentType.includes('+json') ||
    textBasedApplicationTypes.has(normalizedContentType) ||
    hasHtmlExtension;

  if (isTextBased && (preview || artifact.size <= MAX_TEXT_PREVIEW_BYTES)) {
    try {
      const maxBytes = preview
        ? MAX_THUMBNAIL_PREVIEW_BYTES
        : MAX_TEXT_PREVIEW_BYTES;
      const response = await fetch(
        downloadUrl,
        preview ? { headers: { Range: `bytes=0-${maxBytes - 1}` } } : undefined,
      );

      if (response.ok) {
        content = await readTextWithByteLimit(response, maxBytes, preview);
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
    sessionId: artifact.sessionId,
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

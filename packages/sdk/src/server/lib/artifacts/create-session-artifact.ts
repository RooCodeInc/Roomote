import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  db,
  ensureSessionForFastConversation,
  eq,
  taskArtifacts,
} from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';
import {
  getArtifactStorageKey,
  type TaskArtifactType,
  validateTaskArtifactPath,
} from '@roomote/types';

import { createArtifactRecord } from './create-record';
import { buildSignedArtifactRawUrl, currentEpochSeconds } from './raw-url';

const MAX_FAST_ARTIFACT_BYTES = 128 * 1024;
/** Browser captures from the Fast `browse` tool: screenshots and recordings. */
const MAX_FAST_MEDIA_ARTIFACT_BYTES = 50 * 1024 * 1024;
const FAST_MEDIA_ARTIFACT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/webm',
]);
let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  s3Client ??= new S3Client({
    endpoint: Env.S3_ENDPOINT,
    region: Env.S3_REGION,
    credentials: {
      accessKeyId: Env.S3_ACCESS_KEY_ID,
      secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return s3Client;
}

async function storeSessionArtifact(input: {
  sessionId: string;
  path: string;
  content: Buffer;
  contentType: string;
  artifactType: TaskArtifactType;
}) {
  const pathError = validateTaskArtifactPath(input.path);
  if (pathError) throw new Error(pathError);
  const { content } = input;

  const artifact = await createArtifactRecord({
    sessionId: input.sessionId,
    artifactType: input.artifactType,
    contentType: input.contentType,
    path: input.path,
    size: content.length,
  });
  if (!artifact) throw new Error('Failed to create artifact record.');

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: Env.S3_BUCKET_ARTIFACTS,
      Key: getArtifactStorageKey(
        { sessionId: input.sessionId },
        artifact.id,
        artifact.path,
        artifact.version,
      ),
      Body: content,
      ContentType: artifact.contentType,
      ContentLength: artifact.size,
    }),
  );

  const [uploaded] = await db
    .update(taskArtifacts)
    .set({ uploaded: true, updatedAt: new Date() })
    .where(eq(taskArtifacts.id, artifact.id))
    .returning();
  if (!uploaded) throw new Error('Failed to complete artifact upload.');
  return uploaded;
}

export async function createSessionArtifact(input: {
  sessionId: string;
  path: string;
  content: string;
  contentType: string;
  artifactType: Exclude<TaskArtifactType, 'visual-proof'>;
}) {
  const content = Buffer.from(input.content, 'utf8');
  if (content.length === 0)
    throw new Error('Artifact content cannot be empty.');
  if (content.length > MAX_FAST_ARTIFACT_BYTES) {
    throw new Error('Fast artifacts cannot exceed 128 KiB.');
  }
  return storeSessionArtifact({ ...input, content });
}

/**
 * Binary media captured on the control plane for a Session (the Fast
 * `browse` tool's screenshots and recordings). Stored as `visual-proof`, the
 * same type task sandboxes use for their captures, so the Session Artifacts
 * panel and transcript previews treat both alike.
 */
export async function createSessionMediaArtifact(input: {
  sessionId: string;
  path: string;
  content: Buffer;
  contentType: string;
}) {
  if (!FAST_MEDIA_ARTIFACT_CONTENT_TYPES.has(input.contentType)) {
    throw new Error(`Unsupported media artifact type: ${input.contentType}`);
  }
  if (input.content.length === 0)
    throw new Error('Artifact content cannot be empty.');
  if (input.content.length > MAX_FAST_MEDIA_ARTIFACT_BYTES) {
    throw new Error('Fast media artifacts cannot exceed 50 MiB.');
  }
  return storeSessionArtifact({ ...input, artifactType: 'visual-proof' });
}

function buildSessionArtifactViewUrl(
  sessionId: string,
  artifact: { path: string; version: number },
): string {
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/u, '');
  // Deep link into the Session Artifacts panel; mirrors
  // getSessionArtifactViewUrl in apps/web/src/lib/artifact-view-urls.ts.
  return `${baseUrl}/sessions/${sessionId}?artifact=${encodeURIComponent(artifact.path)}&v=${artifact.version}`;
}

export async function createFastAgentSessionMediaArtifact(
  input: Parameters<typeof createSessionMediaArtifact>[0],
) {
  const artifact = await createSessionMediaArtifact(input);
  return {
    id: artifact.id,
    path: artifact.path,
    version: artifact.version,
    artifactType: 'visual-proof' as const,
    contentType: artifact.contentType,
    size: artifact.size,
    viewUrl: buildSessionArtifactViewUrl(input.sessionId, artifact),
    // Signed raw URL the transcript and chat surfaces can embed directly.
    rawUrl: buildSignedArtifactRawUrl({
      artifactId: artifact.id,
      ts: currentEpochSeconds(),
      apiBaseUrl: Env.R_APP_URL,
      signingKey: getArtifactSigningKey(),
    }),
  };
}

export async function createFastAgentConversationMediaArtifact(
  input: Omit<Parameters<typeof createSessionMediaArtifact>[0], 'sessionId'> & {
    fastConversationId: string;
  },
) {
  const session = await ensureSessionForFastConversation(
    db,
    input.fastConversationId,
  );
  const { fastConversationId: _fastConversationId, ...artifact } = input;
  return createFastAgentSessionMediaArtifact({
    sessionId: session.id,
    ...artifact,
  });
}

export async function createFastAgentSessionArtifact(
  input: Parameters<typeof createSessionArtifact>[0],
) {
  const artifact = await createSessionArtifact(input);
  return {
    id: artifact.id,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType as 'general' | 'plan',
    contentType: artifact.contentType,
    size: artifact.size,
    viewUrl: buildSessionArtifactViewUrl(input.sessionId, artifact),
  };
}

export async function createFastAgentConversationArtifact(
  input: Omit<Parameters<typeof createSessionArtifact>[0], 'sessionId'> & {
    fastConversationId: string;
  },
) {
  const session = await ensureSessionForFastConversation(
    db,
    input.fastConversationId,
  );
  const { fastConversationId: _fastConversationId, ...artifact } = input;
  return createFastAgentSessionArtifact({ sessionId: session.id, ...artifact });
}

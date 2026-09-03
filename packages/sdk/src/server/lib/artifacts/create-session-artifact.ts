import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  db,
  ensureSessionForFastConversation,
  eq,
  taskArtifacts,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  getArtifactStorageKey,
  type TaskArtifactType,
  validateTaskArtifactPath,
} from '@roomote/types';

import { createArtifactRecord } from './create-record';

const MAX_FAST_ARTIFACT_BYTES = 128 * 1024;
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

export async function createSessionArtifact(input: {
  sessionId: string;
  path: string;
  content: string;
  contentType: string;
  artifactType: Exclude<TaskArtifactType, 'visual-proof'>;
}) {
  const pathError = validateTaskArtifactPath(input.path);
  if (pathError) throw new Error(pathError);

  const content = Buffer.from(input.content, 'utf8');
  if (content.length === 0)
    throw new Error('Artifact content cannot be empty.');
  if (content.length > MAX_FAST_ARTIFACT_BYTES) {
    throw new Error('Fast artifacts cannot exceed 128 KiB.');
  }

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

export async function createFastAgentSessionArtifact(
  input: Parameters<typeof createSessionArtifact>[0],
) {
  const artifact = await createSessionArtifact(input);
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/u, '');
  return {
    id: artifact.id,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType as 'general' | 'plan',
    contentType: artifact.contentType,
    size: artifact.size,
    viewUrl: `${baseUrl}/sessions/${input.sessionId}`,
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

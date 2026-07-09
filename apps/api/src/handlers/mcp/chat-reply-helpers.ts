import crypto from 'node:crypto';
import { basename } from 'node:path';

import { getRedis } from '@roomote/redis';

import { Env, getArtifactSigningKey } from '@roomote/env';
import { db, inArray, taskArtifacts } from '@roomote/db/server';
import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from '@roomote/sdk/server';

const THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS = 30;
const THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS = 8;
const THREAD_REPLY_FOOTER_LOCK_RETRY_MS = 100;
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

export type ThreadReplyImage = {
  url: string;
  altText: string;
  contentType: string;
};

export async function buildThreadReplyImages(params: {
  artifactIds: string[];
  cloudJob: {
    id: number;
    taskId: string;
  };
}): Promise<ThreadReplyImage[]> {
  const ts = currentEpochSeconds();
  const images: ThreadReplyImage[] = [];

  if (params.artifactIds.length === 0) {
    return images;
  }

  const artifacts = await db.query.taskArtifacts.findMany({
    columns: {
      id: true,
      taskId: true,
      cloudJobId: true,
      contentType: true,
      uploaded: true,
      path: true,
    },
    where: inArray(taskArtifacts.id, params.artifactIds),
  });

  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact]),
  );

  for (const artifactId of params.artifactIds) {
    const artifact = artifactsById.get(artifactId);

    if (!artifact) {
      throw new Error(`Unknown artifact id: ${artifactId}`);
    }

    if (artifact.taskId !== params.cloudJob.taskId) {
      throw new Error(
        `Artifact ${artifactId} does not belong to the current task`,
      );
    }

    if (
      artifact.cloudJobId !== null &&
      artifact.cloudJobId !== params.cloudJob.id
    ) {
      throw new Error(
        `Artifact ${artifactId} does not belong to the current cloud job`,
      );
    }

    if (!artifact.uploaded) {
      throw new Error(`Artifact ${artifactId} has not been uploaded yet`);
    }

    if (!artifact.contentType.startsWith('image/')) {
      throw new Error(`Artifact ${artifactId} is not an image attachment`);
    }

    images.push({
      url: buildSignedArtifactRawUrl({
        artifactId: artifact.id,
        ts,
        apiBaseUrl: Env.ROOMOTE_APP_URL,
        signingKey: getArtifactSigningKey(),
      }),
      altText: basename(artifact.path) || 'attachment',
      contentType: artifact.contentType,
    });
  }

  return images;
}

export async function buildThreadReplyImageBlocks(params: {
  artifactIds: string[];
  cloudJob: {
    id: number;
    taskId: string;
  };
}): Promise<
  Array<{
    type: 'image';
    image_url: string;
    alt_text: string;
  }>
> {
  const images = await buildThreadReplyImages(params);

  const imageBlocks = images.map((image) => ({
    type: 'image' as const,
    image_url: image.url,
    alt_text: image.altText,
  }));

  return imageBlocks;
}

export function errorResponseForThreadReplyImageError(
  message: string,
): Response | null {
  if (message.startsWith('Unknown artifact id: ')) {
    return new Response(JSON.stringify({ error: message }), { status: 404 });
  }

  if (
    message.includes('does not belong to the current task') ||
    message.includes('does not belong to the current cloud job')
  ) {
    return new Response(JSON.stringify({ error: message }), { status: 403 });
  }

  if (
    message.includes('has not been uploaded yet') ||
    message.includes('is not an image attachment')
  ) {
    return new Response(JSON.stringify({ error: message }), { status: 400 });
  }

  return null;
}

export async function withThreadReplyFooterLock<T>(params: {
  lockKey: string;
  maxAcquireAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  const redis = getRedis();
  const maxAcquireAttempts =
    params.maxAcquireAttempts ?? THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const ownerId = crypto.randomUUID();
    const acquired = await redis.set(
      params.lockKey,
      ownerId,
      'EX',
      THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
      'NX',
    );

    if (acquired) {
      try {
        return await params.fn();
      } finally {
        await redis
          .eval(RELEASE_LOCK_SCRIPT, 1, params.lockKey, ownerId)
          .catch(() => {});
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, THREAD_REPLY_FOOTER_LOCK_RETRY_MS),
    );
  }

  throw new Error(THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE);
}

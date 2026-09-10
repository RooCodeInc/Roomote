import { basename } from 'node:path';

export {
  withThreadReplyFooterLock,
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE,
} from '@roomote/communication/thread-reply-footer-delivery';

import { Env, getArtifactSigningKey } from '@roomote/env';
import { db, inArray, taskArtifacts } from '@roomote/db/server';
import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from '@roomote/sdk/server';

export type ThreadReplyImage = {
  url: string;
  altText: string;
  contentType: string;
};

export async function buildThreadReplyImages(params: {
  artifactIds: string[];
  taskRun: {
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
      runId: true,
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

    if (artifact.taskId !== params.taskRun.taskId) {
      throw new Error(
        `Artifact ${artifactId} does not belong to the current task`,
      );
    }

    if (artifact.runId !== null && artifact.runId !== params.taskRun.id) {
      throw new Error(
        `Artifact ${artifactId} does not belong to the current task run`,
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
        apiBaseUrl: Env.R_APP_URL,
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
  taskRun: {
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
    return new Response(JSON.stringify({ error: 'Unknown artifact id' }), {
      status: 404,
    });
  }

  if (
    message.includes('does not belong to the current task') ||
    message.includes('does not belong to the current task run')
  ) {
    return new Response(
      JSON.stringify({ error: 'Artifact does not belong to the current task' }),
      { status: 403 },
    );
  }

  if (
    message.includes('has not been uploaded yet') ||
    message.includes('is not an image attachment')
  ) {
    return new Response(JSON.stringify({ error: 'Invalid image artifact' }), {
      status: 400,
    });
  }

  return null;
}

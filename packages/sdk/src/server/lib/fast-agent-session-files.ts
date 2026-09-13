import { basename } from 'node:path';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fastAgentConversationRepository } from '@roomote/cloud-agents/server';
import { and, db, inArray, taskArtifacts, taskRuns } from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { CommunicationMessageFile } from '@roomote/communication';
import { getArtifactStorageKey } from '@roomote/types';

import {
  convertFastAgentWebmToMp4,
  MAX_FAST_VIDEO_BYTES,
} from './fast-agent-video-conversion';

const IO_TIMEOUT_MS = 30_000;
let s3Client: S3Client | undefined;

type FastAgentFileSelectionEvent = {
  artifactIds: string[];
  taskId: string;
  runId: number;
};

export async function prepareFastAgentSessionFiles(params: {
  artifactIds: string[];
  sessionId: string;
  kind: 'video' | 'document';
  event?: FastAgentFileSelectionEvent;
}): Promise<{ files: CommunicationMessageFile[]; fallbackText: string }> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (artifactIds.length === 0) return { files: [], fallbackText: '' };

  const artifacts = await db.query.taskArtifacts.findMany({
    where: inArray(taskArtifacts.id, artifactIds),
    columns: {
      id: true,
      taskId: true,
      runId: true,
      path: true,
      version: true,
      contentType: true,
      uploaded: true,
      size: true,
    },
  });
  const sessionRunTaskById = new Map<number, string>();
  if (!params.event) {
    const runIds = artifacts.flatMap((artifact) =>
      artifact.runId === null ? [] : [artifact.runId],
    );
    if (runIds.length > 0) {
      const lookupIds = await fastAgentConversationRepository.getLookupIds(
        params.sessionId,
      );
      const runs = await db.query.taskRuns.findMany({
        where: and(
          inArray(taskRuns.id, runIds),
          inArray(taskRuns.fastAgentSessionId, lookupIds),
        ),
        columns: { id: true, taskId: true },
      });
      for (const run of runs) sessionRunTaskById.set(run.id, run.taskId);
    }
  }

  const eventIds = new Set(params.event?.artifactIds ?? []);
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const selected = artifactIds.map((id) => {
    const artifact = byId.get(id);
    const owned = params.event
      ? artifact &&
        eventIds.has(id) &&
        artifact.taskId === params.event.taskId &&
        artifact.runId === params.event.runId
      : artifact &&
        artifact.runId !== null &&
        artifact.taskId === sessionRunTaskById.get(artifact.runId);
    const expectedContentType =
      params.kind === 'video'
        ? artifact?.contentType.startsWith('video/')
        : artifact &&
          !artifact.contentType.startsWith('image/') &&
          !artifact.contentType.startsWith('video/');
    if (
      !artifact ||
      !artifact.uploaded ||
      artifact.taskId === null ||
      !owned ||
      !expectedContentType
    ) {
      throw new Error(`Invalid Fast parent ${params.kind} artifact: ${id}`);
    }
    const encodedPath = artifact.path
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
    return {
      ...artifact,
      taskId: artifact.taskId,
      filename:
        basename(artifact.path) || (params.kind === 'video' ? 'video' : 'file'),
      viewUrl: `${baseUrl}/task/${encodeURIComponent(artifact.taskId)}/artifacts/${encodedPath}?v=${artifact.version}`,
    };
  });

  const files: CommunicationMessageFile[] = [];
  const fallbacks: string[] = [];
  for (const artifact of selected) {
    const label = params.kind === 'video' ? 'video' : 'file';
    const fallbackText = `View ${label}: ${artifact.viewUrl}`;
    if (artifact.size <= 0 || artifact.size > MAX_FAST_VIDEO_BYTES) {
      fallbacks.push(fallbackText);
      continue;
    }
    let stage = 'storage';
    try {
      s3Client ??= new S3Client({
        endpoint: Env.S3_ENDPOINT,
        region: Env.S3_REGION,
        credentials: {
          accessKeyId: Env.S3_ACCESS_KEY_ID,
          secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      });
      const signal = AbortSignal.timeout(IO_TIMEOUT_MS);
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: Env.S3_BUCKET_ARTIFACTS,
          Key: getArtifactStorageKey(
            { taskId: artifact.taskId },
            artifact.id,
            artifact.path,
            artifact.version,
          ),
        }),
        { abortSignal: signal },
      );
      if ((object.ContentLength ?? 0) > MAX_FAST_VIDEO_BYTES) {
        throw new Error('Artifact size limit exceeded.');
      }
      if (!object.Body) throw new Error('Artifact content unavailable.');
      const reader = object.Body.transformToWebStream().getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_FAST_VIDEO_BYTES) {
            throw new Error('Artifact size limit exceeded.');
          }
          chunks.push(chunk.value);
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
      }
      if (size === 0) throw new Error('Artifact content is empty.');
      const bytes = Buffer.concat(chunks, size);

      let deliveryBytes: Uint8Array = bytes;
      let filename = artifact.filename;
      let contentType =
        artifact.contentType.split(';')[0]?.trim() ||
        'application/octet-stream';
      let kind: CommunicationMessageFile['kind'] = 'document';
      if (params.kind === 'video') {
        const webm = contentType === 'video/webm' || /\.webm$/i.test(filename);
        if (webm) {
          stage = 'conversion';
          try {
            deliveryBytes = await convertFastAgentWebmToMp4(bytes);
            filename = `${filename.replace(/\.[^.]+$/, '')}.mp4`;
            contentType = 'video/mp4';
          } catch {
            // Telegram can still deliver unsupported video formats as documents.
          }
        }
        if (contentType === 'video/mp4' || /\.mp4$/i.test(filename)) {
          kind = 'video';
        }
      }
      files.push({
        bytes: deliveryBytes,
        filename,
        contentType,
        kind,
        fallbackText,
      });
    } catch {
      console.warn('[Fast Agent] Telegram artifact preparation failed.', {
        sessionId: params.sessionId,
        artifactId: artifact.id,
        stage,
      });
      fallbacks.push(fallbackText);
    }
  }

  return { files, fallbackText: fallbacks.join('\n\n') };
}

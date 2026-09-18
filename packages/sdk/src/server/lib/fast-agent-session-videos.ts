import { basename } from 'node:path';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fastAgentConversationRepository } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  inArray,
  slackInstallations,
  taskArtifacts,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import { createSlackWebClient } from '@roomote/slack';
import {
  getArtifactStorageKey,
  type ArtifactStorageOwner,
} from '@roomote/types';

import {
  convertFastAgentWebmToMp4,
  MAX_FAST_VIDEO_BYTES,
} from './fast-agent-video-conversion';

const IO_TIMEOUT_MS = 30_000;
const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
let s3Client: S3Client | undefined;

// Keep storage reads on the owned-object API, not a caller-provided artifact URL.
async function getOwnedArtifactObject(
  owner: ArtifactStorageOwner,
  artifactId: string,
  path: string,
  version: number,
  signal: AbortSignal,
) {
  s3Client ??= new S3Client({
    endpoint: Env.S3_ENDPOINT,
    region: Env.S3_REGION,
    credentials: {
      accessKeyId: Env.S3_ACCESS_KEY_ID,
      secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return s3Client.send(
    new GetObjectCommand({
      Bucket: Env.S3_BUCKET_ARTIFACTS,
      Key: getArtifactStorageKey(owner, artifactId, path, version),
    }),
    { abortSignal: signal },
  );
}

export async function resolveFastAgentSessionVideos(params: {
  artifactIds: string[];
  sessionId: string;
}) {
  const artifactIds = [...new Set(params.artifactIds)];
  if (artifactIds.length === 0) return [];
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
  const runIds = artifacts.flatMap((artifact) =>
    artifact.runId === null ? [] : [artifact.runId],
  );
  const sessionRunTaskById = new Map<number, string>();
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
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  // Validate the entire batch before any storage reads, conversion, KV writes or Slack calls.
  return artifactIds.map((id) => {
    const artifact = byId.get(id);
    if (
      !artifact ||
      !artifact.uploaded ||
      artifact.runId === null ||
      artifact.taskId === null ||
      artifact.taskId !== sessionRunTaskById.get(artifact.runId) ||
      !artifact.contentType.startsWith('video/')
    ) {
      throw new Error(`Invalid Fast parent video artifact: ${id}`);
    }
    const encodedPath = artifact.path
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
    return {
      ...artifact,
      taskId: artifact.taskId,
      filename: basename(artifact.path) || 'video',
      viewUrl: `${baseUrl}/task/${encodeURIComponent(artifact.taskId)}/artifacts/${encodedPath}?v=${artifact.version}`,
    };
  });
}

export async function deliverFastAgentSessionVideos(params: {
  artifactIds: string[];
  sessionId: string;
  channelId: string;
  threadTs: string;
}): Promise<string> {
  const videos = await resolveFastAgentSessionVideos(params);
  if (videos.length === 0) return '';
  const fallback = (video: (typeof videos)[number]) =>
    `[View video](${video.viewUrl})`;
  const session = await fastAgentConversationRepository.findById({
    id: params.sessionId,
  });
  const conversation = session?.conversation;
  if (
    !conversation ||
    conversation.surface !== 'slack' ||
    conversation.replyTarget.channelId !== params.channelId ||
    conversation.replyTarget.threadId !== params.threadTs
  ) {
    throw new Error('Invalid Fast video Slack destination.');
  }
  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.isActive, true),
      eq(slackInstallations.teamId, conversation.workspaceId),
    ),
    columns: { botAccessToken: true },
  });
  if (!installation?.botAccessToken) {
    console.warn('[Fast Agent] Native Slack video delivery unavailable.', {
      sessionId: session.id,
      stage: 'credentials',
    });
    return videos.map(fallback).join('\n\n');
  }
  const client = createSlackWebClient(installation.botAccessToken, {
    timeout: IO_TIMEOUT_MS,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
  const failures: string[] = [];
  for (const video of videos) {
    // Canonical Session ID also deduplicates legacy conversation-ID retries.
    const key = `fast-slack-video:${JSON.stringify([session.id, params.channelId, params.threadTs, video.id])}`;
    let claimed = false;
    let completing = false;
    let stage = 'claim';
    try {
      const redis = getRedis();
      claimed =
        (await redis.set(key, 'pending', 'EX', DELIVERY_TTL_SECONDS, 'NX')) ===
        'OK';
      if (!claimed) {
        if ((await redis.get(key)) !== 'delivered')
          failures.push(fallback(video));
        continue;
      }
      stage = 'size';
      if (video.size <= 0 || video.size > MAX_FAST_VIDEO_BYTES)
        throw new Error('Video size limit exceeded.');
      stage = 'storage';
      const signal = AbortSignal.timeout(IO_TIMEOUT_MS);
      const object = await getOwnedArtifactObject(
        { taskId: video.taskId },
        video.id,
        video.path,
        video.version,
        signal,
      );
      const reader = object.Body?.transformToWebStream().getReader();
      if (!reader) throw new Error('Video content unavailable.');
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      let bytes: Buffer;
      try {
        signal.throwIfAborted();
        if ((object.ContentLength ?? 0) > MAX_FAST_VIDEO_BYTES)
          throw new Error('Video size limit exceeded.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_FAST_VIDEO_BYTES)
            throw new Error('Video size limit exceeded.');
          chunks.push(chunk.value);
        }
        if (size === 0) throw new Error('Video content is empty.');
        bytes = Buffer.concat(chunks, size);
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
      }
      const webm =
        video.contentType.split(';')[0]?.trim().toLowerCase() ===
          'video/webm' || /\.webm$/i.test(video.filename);
      if (webm) {
        stage = 'conversion';
        bytes = await convertFastAgentWebmToMp4(bytes);
      }
      const filename = webm
        ? `${video.filename.replace(/\.[^.]+$/, '')}.mp4`
        : video.filename;
      stage = 'upload-ticket';
      const ticket = await client.files.getUploadURLExternal({
        filename,
        length: bytes.length,
      });
      if (!ticket.ok || !ticket.file_id || !ticket.upload_url)
        throw new Error('Slack upload ticket unavailable.');
      // Only Slack's authenticated ticket supplies the upload URL; never fetch artifact URLs.
      stage = 'upload';
      const uploaded = await fetch(ticket.upload_url, {
        method: 'POST',
        body: new Uint8Array(bytes),
        redirect: 'error',
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
      void uploaded.body?.cancel().catch(() => {});
      if (uploaded.status !== 200) throw new Error('Slack byte upload failed.');
      // Keep the pending claim on any ambiguous completion (including a process crash).
      // Retrying completeUploadExternal is unsafe: Slack only permits it once.
      completing = true;
      stage = 'completion';
      const completed = await client.files.completeUploadExternal({
        files: [{ id: ticket.file_id, title: filename }],
        channel_id: params.channelId,
        thread_ts: params.threadTs,
      });
      if (!completed.ok) throw new Error('Slack upload completion failed.');
      stage = 'delivery-marker';
      await redis.set(key, 'delivered', 'EX', DELIVERY_TTL_SECONDS);
    } catch {
      // Raw provider errors may contain tokens, signed URLs or conversion output.
      console.warn('[Fast Agent] Native Slack video delivery failed.', {
        sessionId: session.id,
        artifactId: video.id,
        stage,
        completing,
      });
      if (claimed && !completing)
        await getRedis()
          .del(key)
          .catch(() => {});
      failures.push(fallback(video));
    }
  }
  return failures.join('\n\n');
}

import type { Context } from 'hono';
import { Hono } from 'hono';

import {
  and,
  db,
  eq,
  getSessionArtifactByPath,
  getTaskArtifactByPath,
  isVisibleTask,
  sessions,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  openArtifactInputSchema,
  isTextArtifactContentType,
  type OpenArtifactInput,
  validateTaskArtifactPath,
} from '@roomote/types';

import type { Variables } from '../../types';
import { customAutomationHistoryAccess } from '../custom-automation-history-access';
import { verifyArtifactRouteTaskReadAccess } from '../artifacts/auth';
import { getArtifactObject } from '../artifacts/storage';
import type { McpAuth } from './middleware';

type ArtifactMcpContext = Context<{
  Variables: Variables & { mcpAuth: McpAuth };
}>;

export const MAX_OPEN_ARTIFACT_BYTES = 1024 * 1024;

function artifactMetadata(artifact: {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  path: string;
  version: number;
  artifactType: string;
  contentType: string;
  size: number;
}) {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    sessionId: artifact.sessionId,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType,
    contentType: artifact.contentType,
    size: artifact.size,
  };
}

async function readTextBody(body: {
  transformToWebStream: () => ReadableStream<Uint8Array>;
}): Promise<{ content?: string; tooLarge: boolean; invalidEncoding: boolean }> {
  const reader = body.transformToWebStream().getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (totalBytes + value.byteLength > MAX_OPEN_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true, invalidEncoding: false };
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      tooLarge: false,
      invalidEncoding: false,
    };
  } catch {
    return { tooLarge: false, invalidEncoding: true };
  }
}

async function hasTaskReadAccess(taskId: string, auth: McpAuth) {
  if (auth.authContext.tokenType === 'run') {
    return verifyArtifactRouteTaskReadAccess(taskId, auth.authContext);
  }

  const task = await db.query.tasks.findFirst({
    columns: { id: true },
    where: and(
      eq(tasks.id, taskId),
      isVisibleTask(),
      customAutomationHistoryAccess(auth, 'task'),
    ),
  });

  return task
    ? { ok: true as const }
    : {
        ok: false as const,
        status: 403 as const,
        error: 'Artifact access denied',
      };
}

async function hasSessionReadAccess(sessionId: string, auth: McpAuth) {
  const session = await db.query.sessions.findFirst({
    columns: { id: true },
    where: and(
      eq(sessions.id, sessionId),
      eq(sessions.visibility, 'visible'),
      customAutomationHistoryAccess(auth, 'session'),
    ),
  });

  return session
    ? { ok: true as const }
    : {
        ok: false as const,
        status: 403 as const,
        error: 'Artifact access denied',
      };
}

async function resolveCurrentTaskId(auth: McpAuth): Promise<string | null> {
  if (auth.authContext.tokenType !== 'run') {
    return null;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: { taskId: true },
    where: eq(taskRuns.id, auth.authContext.runId),
  });
  return taskRun?.taskId ?? null;
}

async function openArtifact(c: ArtifactMcpContext): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = openArtifactInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid open_artifact input' }, 400);
  }

  const input: OpenArtifactInput = parsed.data;
  const auth = c.get('mcpAuth');
  const currentTaskId =
    !input.taskId && !input.sessionId ? await resolveCurrentTaskId(auth) : null;
  const resolvedInput = currentTaskId
    ? { ...input, taskId: currentTaskId }
    : input;
  const hasTaskId = Boolean(resolvedInput.taskId);
  const hasSessionId = Boolean(resolvedInput.sessionId);
  if (hasTaskId === hasSessionId) {
    return c.json({ error: 'Provide exactly one of taskId or sessionId' }, 400);
  }

  const pathError = validateTaskArtifactPath(resolvedInput.path);
  if (pathError) {
    return c.json({ error: pathError }, 400);
  }

  const taskAccess = resolvedInput.taskId
    ? await hasTaskReadAccess(resolvedInput.taskId, auth)
    : await hasSessionReadAccess(resolvedInput.sessionId!, auth);
  if (!taskAccess.ok) {
    return c.json({ error: taskAccess.error }, taskAccess.status);
  }

  const artifact = resolvedInput.taskId
    ? await getTaskArtifactByPath({
        taskId: resolvedInput.taskId,
        path: resolvedInput.path,
        version: resolvedInput.version,
      })
    : await getSessionArtifactByPath({
        sessionId: resolvedInput.sessionId!,
        path: resolvedInput.path,
        version: resolvedInput.version,
      });

  if (!artifact) {
    return c.json({ error: 'Artifact not found or access denied' }, 404);
  }

  const metadata = artifactMetadata(artifact);
  if (!artifact.uploaded) {
    return c.json(
      { error: 'Artifact has not been uploaded yet', artifact: metadata },
      409,
    );
  }

  if (!isTextArtifactContentType(artifact.contentType)) {
    return c.json(
      {
        error: 'Artifact format is not supported by open_artifact',
        artifact: metadata,
      },
      415,
    );
  }

  if (artifact.size > MAX_OPEN_ARTIFACT_BYTES) {
    return c.json(
      {
        error: 'Artifact is too large to open',
        artifact: metadata,
        maxBytes: MAX_OPEN_ARTIFACT_BYTES,
      },
      413,
    );
  }

  let object: Awaited<ReturnType<typeof getArtifactObject>>;
  try {
    object = await getArtifactObject(
      artifact.taskId
        ? { taskId: artifact.taskId }
        : { sessionId: artifact.sessionId! },
      artifact.id,
      artifact.path,
      artifact.version,
    );
  } catch {
    return c.json({ error: 'Failed to retrieve artifact content' }, 502);
  }

  if (!object.Body) {
    return c.json({ error: 'Artifact content is empty' }, 502);
  }
  if (
    object.ContentLength !== undefined &&
    object.ContentLength > MAX_OPEN_ARTIFACT_BYTES
  ) {
    return c.json(
      {
        error: 'Artifact is too large to open',
        artifact: metadata,
        maxBytes: MAX_OPEN_ARTIFACT_BYTES,
      },
      413,
    );
  }

  let result: Awaited<ReturnType<typeof readTextBody>>;
  try {
    result = await readTextBody(object.Body);
  } catch {
    return c.json({ error: 'Failed to retrieve artifact content' }, 502);
  }
  if (result.tooLarge) {
    return c.json(
      {
        error: 'Artifact is too large to open',
        artifact: metadata,
        maxBytes: MAX_OPEN_ARTIFACT_BYTES,
      },
      413,
    );
  }
  if (result.invalidEncoding) {
    return c.json(
      { error: 'Artifact is not valid UTF-8 text', artifact: metadata },
      415,
    );
  }

  return c.json({ ...metadata, content: result.content ?? '' });
}

export const artifactMcpRouter = new Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>();

artifactMcpRouter.post('/open', openArtifact);

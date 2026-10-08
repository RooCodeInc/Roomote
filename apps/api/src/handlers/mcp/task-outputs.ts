import { basename } from 'node:path';

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getRoomoteMcpResourceUrl } from '@roomote/auth';
import {
  and,
  asc,
  db,
  eq,
  isVisibleTask,
  sql,
  taskMessages,
  tasks,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  asFiniteNumber,
  asStringOrNull,
  taskOutputReadInputSchema,
  truncateAcpOutputText,
} from '@roomote/types';

import type { Variables } from '../../types';
import { customAutomationHistoryAccess } from '../custom-automation-history-access';
import {
  getArtifactById,
  getArtifactByPath,
  listArtifactsByTask,
} from '../artifacts/service';
import { getArtifactObject } from '../artifacts/storage';
import type { McpAuth } from './middleware';
import { McpProxyError } from './proxy-utils';
import { resolveRoomoteMemberAuth } from './roomote-member-auth';

type MemberContext = Context<{ Variables: Variables & { mcpAuth: McpAuth } }>;

async function requireReadableTask(taskId: string, auth: McpAuth) {
  const member = resolveRoomoteMemberAuth(auth.authContext);
  const task = await db.query.tasks.findFirst({
    columns: { id: true },
    where: and(
      eq(tasks.id, taskId),
      isVisibleTask(),
      customAutomationHistoryAccess(member, 'task'),
    ),
  });
  if (!task) throw new McpProxyError(404, 'Task not found');
}

function metadata(artifact: {
  id: string;
  taskId: string | null;
  runId: number | null;
  path: string;
  version: number;
  artifactType: string;
  contentType: string;
  size: number;
  createdAt: Date;
}) {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    runId: artifact.runId,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType,
    contentType: artifact.contentType,
    size: artifact.size,
    createdAt: artifact.createdAt,
  };
}

const commandCursorSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string(),
    createdAt: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Date.parse(value))),
    ts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    id: z.string().uuid(),
  })
  .strict();

function decodeCursor(cursor: string | undefined, taskId: string) {
  if (!cursor) return null;
  try {
    const parsed = commandCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.taskId !== taskId) throw new Error('Wrong task');
    return parsed;
  } catch {
    throw new McpProxyError(400, 'Invalid command receipt cursor');
  }
}

async function readTaskOutputs(c: MemberContext): Promise<Response> {
  const input = taskOutputReadInputSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!input.success)
    return c.json({ error: 'Invalid task output read input' }, 400);
  const params = input.data;
  await requireReadableTask(params.taskId, c.get('mcpAuth'));

  if (params.action === 'list_artifacts') {
    const artifacts = await listArtifactsByTask({
      taskId: params.taskId,
      artifactType: params.artifactType,
      auth: {},
    });
    return c.json({
      taskId: params.taskId,
      artifacts: artifacts.map(metadata),
    });
  }

  if (params.action === 'get_artifact_download_url') {
    const artifact = await getArtifactByPath({
      taskId: params.taskId,
      path: params.path,
      version: params.version,
      auth: {},
    });
    if (!artifact) return c.json({ error: 'Artifact not found' }, 404);
    if (!artifact.uploaded)
      return c.json({ error: 'Artifact has not been uploaded yet' }, 409);
    const url = new URL(
      `${getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL)}/task-outputs/download`,
    );
    url.searchParams.set('taskId', params.taskId);
    url.searchParams.set('artifactId', artifact.id);
    return c.json({
      ...metadata(artifact),
      url: url.toString(),
      authentication: 'bearer',
      expiresAt: null,
      instructions:
        'Fetch with the same Authorization: Bearer credential used for public MCP. Task access is checked on every download; this URL grants no access by itself.',
    });
  }

  const cursor = decodeCursor(params.cursor, params.taskId);
  const rows = await db
    .select({
      id: taskMessages.id,
      runId: taskMessages.runId,
      ts: taskMessages.ts,
      createdAt: taskMessages.createdAt,
      cursorCreatedAt: sql<string>`${taskMessages.createdAt}::text`,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, params.taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.ToolResult),
        sql`${taskMessages.payload} ->> 'isExecute' = 'true'`,
        cursor
          ? sql`(${taskMessages.createdAt}, ${taskMessages.ts}, ${taskMessages.id}) > (${cursor.createdAt}::timestamp, ${cursor.ts}, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(
      asc(taskMessages.createdAt),
      asc(taskMessages.ts),
      asc(taskMessages.id),
    )
    .limit(params.limit + 1);
  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  return c.json({
    taskId: params.taskId,
    receipts: page.map((row) => {
      const payload = row.payload;
      const output = truncateAcpOutputText(
        typeof payload.output === 'string' ? payload.output : '',
        ACP_UI_TOOL_OUTPUT_MAX_CHARS,
      );
      return {
        id: row.id,
        runId: row.runId,
        toolCallId: asStringOrNull(payload.toolCallId),
        sessionId: asStringOrNull(payload.sessionId),
        turnId: asStringOrNull(payload.turnId),
        ts: Number(row.ts),
        createdAt: row.createdAt,
        command: asStringOrNull(payload.command),
        exitCode: asFiniteNumber(payload.exitCode) ?? null,
        status: asStringOrNull(payload.status),
        output: output.text,
        outputTruncation: output.truncation,
      };
    }),
    returned: page.length,
    nextCursor:
      rows.length > params.limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              taskId: params.taskId,
              createdAt: last.cursorCreatedAt,
              ts: Number(last.ts),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
    outputMaxChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  });
}

export const taskOutputsRouter = new Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>();
taskOutputsRouter.onError((error, c) => {
  if (error instanceof McpProxyError)
    return c.json(
      { error: error.message },
      error.httpStatus as 400 | 401 | 403 | 404,
    );
  throw error;
});
taskOutputsRouter.post('/read', readTaskOutputs);

/** Download URLs are not bearer capabilities: authorization is rechecked per GET. */
export async function downloadMemberTaskArtifact(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  c.header('Cache-Control', 'private, no-store');
  try {
    const auth = resolveRoomoteMemberAuth(c.get('authContext'));
    const input = z
      .object({
        taskId: z.string().regex(/^[0-9a-z]{13}$/),
        artifactId: z.string().uuid(),
      })
      .strict()
      .safeParse(c.req.query());
    if (!input.success)
      return c.json({ error: 'Invalid artifact download input' }, 400);
    await requireReadableTask(input.data.taskId, auth);
    const artifact = await getArtifactById({ ...input.data, auth: {} });
    if (!artifact) return c.json({ error: 'Artifact not found' }, 404);
    if (!artifact.uploaded)
      return c.json({ error: 'Artifact has not been uploaded yet' }, 409);
    const object = await getArtifactObject(
      { taskId: input.data.taskId },
      artifact.id,
      artifact.path,
      artifact.version,
    );
    if (!object.Body)
      return c.json({ error: 'Artifact content is empty' }, 502);
    c.header('Content-Type', artifact.contentType);
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(basename(artifact.path))}`,
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return c.body(object.Body.transformToWebStream());
  } catch (error) {
    if (error instanceof McpProxyError)
      return c.json(
        { error: error.message },
        error.httpStatus as 400 | 401 | 403 | 404,
      );
    return c.json({ error: 'Failed to retrieve artifact content' }, 502);
  }
}

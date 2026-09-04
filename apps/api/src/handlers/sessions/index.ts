import { randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import {
  and,
  db,
  desc,
  deriveSessionStatus,
  ensureSessionForFastConversation,
  eq,
  exists,
  fastAgentConversations,
  getSessionForFastConversation,
  ilike,
  inArray,
  isSessionConversationResponding,
  isNull,
  lt,
  or,
  sessions,
  sessionTasks,
  sql,
  type SQL,
  tasks,
} from '@roomote/db/server';
import { getOrCreateFastAgentSession } from '@roomote/cloud-agents/server';
import { queueFastAgentSurfaceReply } from '@roomote/sdk/server';
import {
  SESSION_STATUSES,
  type RoomoteSearchSessionsResponse,
  type RoomoteSessionChildTask,
  type RoomoteSessionMessagesResponse,
  type RoomoteSessionSummary,
  type RoomoteStartSessionResponse,
  type TaskPhase,
} from '@roomote/types';

import type { Variables } from '../../types';
import { resolveMcpTaskOrSessionUserId, type McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import { getLatestTaskRunsByTaskIds } from '../tasks/helpers';
import {
  getFastSessionMessagesForUser,
  sendMessageToFastSessionForUser,
} from '../tasks/fastSessionCommunication';

type SessionContext = Context<{
  Variables: Variables & { mcpAuth: McpAuth };
}>;

// Sessions follow the same visibility rules as tasks: every authenticated
// user of the deployment can read and interact with every visible Session.
async function findAccessibleSession(sessionId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.visibility, 'visible')))
    .limit(1);
  if (session) return session;

  // Session pages retain persisted Fast conversation UUIDs as alternate
  // identifiers. Resolve those links here too, including conversations whose
  // backfill has not created the canonical Session row yet.
  const [alternate] = await db
    .select({
      conversationId: fastAgentConversations.id,
      session: sessions,
    })
    .from(fastAgentConversations)
    .leftJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .where(eq(fastAgentConversations.id, sessionId))
    .limit(1);
  if (!alternate) return null;
  if (alternate.session) {
    return alternate.session.visibility === 'visible'
      ? alternate.session
      : null;
  }

  return ensureSessionForFastConversation(db, alternate.conversationId);
}

async function sendSessionMessage(c: SessionContext): Promise<Response> {
  const userId = c.get('mcpAuth').userId;
  if (!userId) return c.json({ error: 'User context required' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

  let body: { message?: string };
  try {
    body = (await c.req.json()) as { message?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const message = body.message?.trim();
  if (!message) return c.json({ error: 'message is required' }, 400);

  try {
    const session = await findAccessibleSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (!session.fastConversationId) {
      return c.json({ error: 'Session has no conversation to continue' }, 409);
    }
    const result = await sendMessageToFastSessionForUser({
      sessionId: session.fastConversationId,
      userId,
      message,
    });
    if (result.success) return c.json(result);
    const { status, ...errorBody } = result;
    return c.json(errorBody, { status });
  } catch (error) {
    logHandlerError('sendSessionMessage', error);
    return c.json({ error: 'Failed to send session message' }, 500);
  }
}

async function getChildTasks(sessionIds: string[]) {
  if (sessionIds.length === 0) {
    return new Map<string, RoomoteSessionChildTask[]>();
  }

  const rows = await db
    .select({
      sessionId: sessionTasks.sessionId,
      taskId: tasks.id,
      title: tasks.title,
      state: tasks.state,
      goalStatus: tasks.goalStatus,
      repositoryName: tasks.repositoryName,
      activityAt: tasks.activityAt,
      origin: sessionTasks.origin,
      attachedAt: sessionTasks.attachedAt,
    })
    .from(sessionTasks)
    .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
    .where(
      and(inArray(sessionTasks.sessionId, sessionIds), isNull(tasks.deletedAt)),
    )
    .orderBy(sessionTasks.attachedAt);
  const latestRuns = await getLatestTaskRunsByTaskIds(
    rows.map((row) => row.taskId),
  );
  const bySession = new Map<string, RoomoteSessionChildTask[]>();

  for (const row of rows) {
    const run = latestRuns[row.taskId] ?? null;
    const tasksForSession = bySession.get(row.sessionId) ?? [];
    tasksForSession.push({
      taskId: row.taskId,
      title: row.title,
      state: row.state,
      goalStatus: row.goalStatus,
      repositoryName: row.repositoryName,
      activityAt: row.activityAt,
      origin: row.origin,
      attachedAt: row.attachedAt.toISOString(),
      latestRun: run
        ? {
            status: run.status,
            taskPhase: run.taskPhase as TaskPhase | null,
            error: run.error,
          }
        : null,
    });
    bySession.set(row.sessionId, tasksForSession);
  }

  return bySession;
}

function serializeSession(
  session: typeof sessions.$inferSelect,
  childTasks: RoomoteSessionChildTask[],
): RoomoteSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: deriveSessionStatus({
      conversationResponding: isSessionConversationResponding(session),
      tasks: childTasks.map((task) => ({
        state: task.state,
        taskPhase: task.latestRun?.taskPhase ?? null,
        goalStatus: task.goalStatus,
      })),
    }),
    sourceSurface: session.sourceSurface,
    sourceTrigger: session.sourceTrigger,
    activityAt: session.activityAt,
    createdAt: session.createdAt.toISOString(),
    fastConversationId: session.fastConversationId,
    tasks: childTasks,
  };
}

async function startSession(c: SessionContext): Promise<Response> {
  const userId = await resolveMcpTaskOrSessionUserId(c.get('mcpAuth'));
  if (!userId) return c.json({ error: 'User context required' }, 403);

  let body: { message?: string };
  try {
    body = (await c.req.json()) as { message?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const message = body.message?.trim();
  if (!message) return c.json({ error: 'message is required' }, 400);

  try {
    const conversation = {
      surface: 'web' as const,
      workspaceId: userId,
      conversationId: randomUUID(),
    };
    const fastSession = await getOrCreateFastAgentSession({
      userId,
      conversation,
    });
    const session = await getSessionForFastConversation(db, fastSession.id);
    const queued = await queueFastAgentSurfaceReply({
      sessionId: fastSession.id,
      userId,
      senderDisplayName: null,
      question: message,
      currentMessageId: `mcp-${randomUUID()}`,
    });

    if (!session || !queued) {
      return c.json({ error: 'Failed to start session' }, 500);
    }

    const response = {
      sessionId: session.id,
      fastConversationId: fastSession.id,
      queued: true,
    } satisfies RoomoteStartSessionResponse;
    return c.json(response, 201);
  } catch (error) {
    logHandlerError('startSession', error);
    return c.json({ error: 'Failed to start session' }, 500);
  }
}

async function searchSessions(c: SessionContext): Promise<Response> {
  const userId = c.get('mcpAuth').userId;
  if (!userId) return c.json({ error: 'User context required' }, 403);

  const query = c.req.query('query')?.trim();
  const status = c.req.query('status');
  const sessionStatus = SESSION_STATUSES.find(
    (candidate) => candidate === status,
  );
  if (status && !sessionStatus) {
    return c.json(
      { error: `status must be one of: ${SESSION_STATUSES.join(', ')}` },
      400,
    );
  }
  const parsedLimit = Number(c.req.query('limit') ?? 20);
  if (!Number.isFinite(parsedLimit)) {
    return c.json({ error: 'limit must be a number' }, 400);
  }
  const limit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 100);
  const cursorParam = c.req.query('cursor');
  const cursorActivityAt = cursorParam
    ? Number(cursorParam.split(':')[0])
    : null;
  const cursorId = cursorParam?.split(':')[1];
  if (cursorParam && !Number.isFinite(cursorActivityAt)) {
    return c.json({ error: 'cursor must be activityAt:id' }, 400);
  }

  try {
    const conditions: Array<SQL | undefined> = [
      eq(sessions.visibility, 'visible'),
      isNull(sessions.archivedAt),
    ];
    if (sessionStatus) {
      conditions.push(eq(sessions.cachedStatus, sessionStatus));
    }
    if (query) {
      const pattern = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      conditions.push(
        or(
          ilike(sessions.title, pattern),
          exists(
            db
              .select({ one: sql`1` })
              .from(sessionTasks)
              .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
              .where(
                and(
                  eq(sessionTasks.sessionId, sessions.id),
                  or(
                    ilike(tasks.title, pattern),
                    ilike(tasks.repositoryName, pattern),
                  ),
                ),
              ),
          ),
        ),
      );
    }
    if (cursorActivityAt !== null) {
      conditions.push(
        cursorId
          ? or(
              lt(sessions.activityAt, cursorActivityAt),
              and(
                eq(sessions.activityAt, cursorActivityAt),
                lt(sessions.id, cursorId),
              ),
            )
          : lt(sessions.activityAt, cursorActivityAt),
      );
    }

    const rows = await db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(desc(sessions.activityAt), desc(sessions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const childTasks = await getChildTasks(page.map((session) => session.id));
    const last = page.at(-1);

    const response = {
      sessions: page.map((session) =>
        serializeSession(session, childTasks.get(session.id) ?? []),
      ),
      nextCursor:
        rows.length > limit && last ? `${last.activityAt}:${last.id}` : null,
    } satisfies RoomoteSearchSessionsResponse;
    return c.json(response);
  } catch (error) {
    logHandlerError('searchSessions', error);
    return c.json({ error: 'Failed to search sessions' }, 500);
  }
}

async function getSessionSummary(c: SessionContext): Promise<Response> {
  const userId = c.get('mcpAuth').userId;
  if (!userId) return c.json({ error: 'User context required' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

  try {
    const session = await findAccessibleSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const childTasks = await getChildTasks([session.id]);
    const response = serializeSession(
      session,
      childTasks.get(session.id) ?? [],
    );
    return c.json(response);
  } catch (error) {
    logHandlerError('getSessionSummary', error);
    return c.json({ error: 'Failed to get session summary' }, 500);
  }
}

async function getSessionMessages(c: SessionContext): Promise<Response> {
  const userId = c.get('mcpAuth').userId;
  if (!userId) return c.json({ error: 'User context required' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

  try {
    const session = await findAccessibleSession(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const parsedLimit = Number(c.req.query('limit') ?? 100);
    if (!Number.isFinite(parsedLimit)) {
      return c.json({ error: 'limit must be a number' }, 400);
    }
    const limit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 1000);
    const messages = session.fastConversationId
      ? await getFastSessionMessagesForUser({
          sessionId: session.fastConversationId,
          userId,
          limit,
          order: 'desc',
        })
      : [];
    const childTasks = await getChildTasks([session.id]);

    const response = {
      sessionId: session.id,
      messages: messages ?? [],
      returned: messages?.length ?? 0,
      tasks: childTasks.get(session.id) ?? [],
    } satisfies RoomoteSessionMessagesResponse;
    return c.json(response);
  } catch (error) {
    logHandlerError('getSessionMessages', error);
    return c.json({ error: 'Failed to get session messages' }, 500);
  }
}

export const sessionsRouter = new Hono<{ Variables: Variables }>();
sessionsRouter.get('/', searchSessions);
sessionsRouter.post('/', startSession);
sessionsRouter.get('/:sessionId/summary', getSessionSummary);
sessionsRouter.get('/:sessionId/messages', getSessionMessages);
sessionsRouter.post('/:sessionId/send_message', sendSessionMessage);

import type { Context } from 'hono';

import {
  db,
  tasks,
  taskMessages,
  eq,
  and,
  asc,
  desc,
} from '@roomote/db/server';
import {
  getTextFromContentBlocks,
  getImageUrisFromContentBlocks,
  resolveAcpTranscriptVisibility,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { visibleTaskHistoryCondition } from './helpers';
import { logHandlerError } from '../utils';

/**
 * GET /api/tasks/:taskId/messages
 *
 * Get the message history for a specific task.
 *
 * TODO: Align the response shape with TaskMessageEnvelope (used by the
 * web app) so all consumers share a single canonical message format. The
 * current flat {text, images} shape derives fields that the envelope already
 * carries (contentBlocks, payload, kind, etc.).
 *
 * Query params:
 *   - limit (number, optional): Max messages to return. Returns all if omitted.
 *   - order (string, optional): "asc" (default, oldest first) or "desc" (newest first)
 */
export async function getTaskMessages(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  const limitParam = c.req.query('limit');
  let limit: number | undefined;

  if (limitParam !== undefined) {
    const parsedLimit = Number(limitParam);

    if (!Number.isFinite(parsedLimit)) {
      return c.json({ error: 'limit must be a number' }, 400);
    }

    limit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 1000);
  }

  const orderParam = c.req.query('order');

  if (orderParam && orderParam !== 'asc' && orderParam !== 'desc') {
    return c.json({ error: 'order must be one of: asc, desc' }, 400);
  }

  const order = orderParam ?? 'asc';

  try {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), visibleTaskHistoryCondition))
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const orderBy =
      order === 'desc'
        ? [desc(taskMessages.ts), desc(taskMessages.createdAt)]
        : [asc(taskMessages.ts), asc(taskMessages.createdAt)];

    let query = db
      .select({
        id: taskMessages.id,
        taskId: taskMessages.taskId,
        ts: taskMessages.ts,
        eventType: taskMessages.eventType,
        role: taskMessages.role,
        contentBlocks: taskMessages.contentBlocks,
        metadata: taskMessages.metadata,
        payload: taskMessages.payload,
        createdAt: taskMessages.createdAt,
      })
      .from(taskMessages)
      .where(eq(taskMessages.taskId, taskId))
      .orderBy(...orderBy);

    if (limit) {
      query = query.limit(limit) as typeof query;
    }

    const rows = await query;

    const messages = rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      ts: Number(row.ts),
      eventType: row.eventType,
      role: row.role,
      text: getTextFromContentBlocks(row.contentBlocks),
      images: getImageUrisFromContentBlocks(row.contentBlocks),
      metadata: row.metadata,
      visibleInTranscript: resolveAcpTranscriptVisibility({
        eventType: row.eventType,
        contentBlocks: row.contentBlocks,
        metadata: row.metadata,
        payload: row.payload,
      }),
    }));

    return c.json({ messages, returned: messages.length });
  } catch (error) {
    logHandlerError('getTaskMessages', error);
    return c.json({ error: 'Failed to get task messages' }, 500);
  }
}

import type { Context } from 'hono';
import { z } from 'zod';

import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentConversations,
  inArray,
  sql,
  taskMessages,
  tasks,
} from '@roomote/db/server';
import { type RoomoteTranscriptMessagesResponse } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { customAutomationHistoryAccess } from '../custom-automation-history-access';
import { logHandlerError } from '../utils';
import { getFastSessionMessagesForUser } from './fastSessionCommunication';
import { visibleTaskHistoryCondition } from './helpers';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
  type MessageHistoryCursor,
  type MessageHistoryPosition,
  type MessageHistorySnapshot,
} from './message-history-pagination';
import {
  collectMessagePage,
  coverageForMessages,
  parseMessageLimit,
  snapshotForMessageRow,
  type MessageHistoryRow,
} from './message-history-serialization';

type MessageOrder = 'asc' | 'desc';

function taskSnapshotCondition(
  snapshot: MessageHistorySnapshot,
  taskId: string,
) {
  return sql`(${taskMessages.createdAt}, ${taskMessages.id}) <= (select ${taskMessages.createdAt}, ${taskMessages.id} from ${taskMessages} where ${taskMessages.id} = ${snapshot.id}::uuid and ${taskMessages.taskId} = ${taskId})`;
}

function taskPositionCondition(
  position: MessageHistoryPosition,
  taskId: string,
  order: MessageOrder,
) {
  const anchor = sql`(select ${taskMessages.ts}, ${taskMessages.createdAt}, ${taskMessages.id} from ${taskMessages} where ${taskMessages.id} = ${position.id}::uuid and ${taskMessages.taskId} = ${taskId})`;
  return order === 'desc'
    ? sql`(${taskMessages.ts}, ${taskMessages.createdAt}, ${taskMessages.id}) < ${anchor}`
    : sql`(${taskMessages.ts}, ${taskMessages.createdAt}, ${taskMessages.id}) > ${anchor}`;
}

function taskNewerThanSnapshotCondition(
  snapshot: MessageHistorySnapshot,
  taskId: string,
) {
  return sql`(${taskMessages.createdAt}, ${taskMessages.id}) > (select ${taskMessages.createdAt}, ${taskMessages.id} from ${taskMessages} where ${taskMessages.id} = ${snapshot.id}::uuid and ${taskMessages.taskId} = ${taskId})`;
}

function isSameCursorPosition(
  left: MessageHistoryPosition | null,
  right: MessageHistoryPosition | null,
): boolean {
  return left?.id === right?.id;
}

function emptyResponse(
  order: MessageOrder,
  hasNewer = false,
): RoomoteTranscriptMessagesResponse {
  return {
    messages: [],
    returned: 0,
    order,
    hasMore: false,
    nextCursor: null,
    truncated: false,
    hasNewer,
    coverage: coverageForMessages([], false),
  };
}

function buildCursor(params: {
  taskId: string;
  order: MessageOrder;
  snapshot: MessageHistorySnapshot;
  position: MessageHistoryPosition;
}): string {
  const cursor: MessageHistoryCursor = {
    version: 1,
    target: { kind: 'task', id: params.taskId },
    order: params.order,
    snapshot: params.snapshot,
    position: params.position,
  };
  return encodeMessageHistoryCursor(cursor);
}

async function getTaskSnapshot(
  taskId: string,
): Promise<MessageHistorySnapshot | null> {
  const [row] = await db
    .select({ id: taskMessages.id, createdAt: taskMessages.createdAt })
    .from(taskMessages)
    .where(eq(taskMessages.taskId, taskId))
    .orderBy(desc(taskMessages.createdAt), desc(taskMessages.id))
    .limit(1);
  return row ? snapshotForMessageRow(row) : null;
}

async function validateTaskCursor(
  taskId: string,
  cursor: MessageHistoryCursor,
): Promise<boolean> {
  const ids = [cursor.snapshot.id, cursor.position.id];
  const rows = await db
    .select({ id: taskMessages.id })
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), inArray(taskMessages.id, ids)));
  return new Set(rows.map((row) => row.id)).size === new Set(ids).size;
}

async function getTaskMessagePage(params: {
  taskId: string;
  limit: number;
  order: MessageOrder;
  cursor: MessageHistoryCursor | null;
}): Promise<RoomoteTranscriptMessagesResponse> {
  const snapshot =
    params.cursor?.snapshot ?? (await getTaskSnapshot(params.taskId));
  if (!snapshot) return emptyResponse(params.order);

  const orderBy =
    params.order === 'desc'
      ? [
          desc(taskMessages.ts),
          desc(taskMessages.createdAt),
          desc(taskMessages.id),
        ]
      : [
          asc(taskMessages.ts),
          asc(taskMessages.createdAt),
          asc(taskMessages.id),
        ];

  const selectRows = (
    position: MessageHistoryPosition | null,
    limit: number,
  ) => {
    const conditions = [
      eq(taskMessages.taskId, params.taskId),
      taskSnapshotCondition(snapshot, params.taskId),
      ...(position
        ? [taskPositionCondition(position, params.taskId, params.order)]
        : []),
    ];
    return db
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
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit);
  };

  const page = await collectMessagePage({
    limit: params.limit,
    initialPosition: params.cursor?.position ?? null,
    loadRows: async (position, batchSize) =>
      (await selectRows(position, batchSize)) as MessageHistoryRow[],
  });
  const { messages, hasMore, truncated, nextPosition } = page;
  const nextCursor =
    hasMore && nextPosition
      ? buildCursor({
          taskId: params.taskId,
          order: params.order,
          snapshot,
          position: nextPosition,
        })
      : null;
  const hasNewer = Boolean(
    (
      await db
        .select({ id: taskMessages.id })
        .from(taskMessages)
        .where(
          and(
            eq(taskMessages.taskId, params.taskId),
            taskNewerThanSnapshotCondition(snapshot, params.taskId),
          ),
        )
        .limit(1)
    )[0],
  );

  if (
    hasMore &&
    nextCursor !== null &&
    isSameCursorPosition(nextPosition, params.cursor?.position ?? null)
  ) {
    return {
      messages,
      returned: messages.length,
      order: params.order,
      hasMore: false,
      nextCursor: null,
      truncated: true,
      hasNewer,
      coverage: coverageForMessages(messages, false),
    };
  }

  return {
    messages,
    returned: messages.length,
    order: params.order,
    hasMore,
    nextCursor,
    truncated: truncated || hasMore,
    hasNewer,
    coverage: coverageForMessages(messages, hasMore),
  };
}

/**
 * GET /api/tasks/:taskId/messages
 *
 * Read a bounded, stable transcript page. MCP callers use descending order and
 * follow nextCursor to walk toward older messages without loading a full task
 * history into one model context.
 */
export async function getTaskMessages(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'taskId is required' }, 400);

  const limit = parseMessageLimit(c.req.query('limit'));
  if (!limit) return c.json({ error: 'limit must be a number' }, 400);

  const orderParam = c.req.query('order');
  if (orderParam && orderParam !== 'asc' && orderParam !== 'desc') {
    return c.json({ error: 'order must be one of: asc, desc' }, 400);
  }
  const order: MessageOrder = orderParam === 'desc' ? 'desc' : 'asc';
  const cursorValue = c.req.query('cursor');
  const auth = c.get('mcpAuth');

  try {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          visibleTaskHistoryCondition,
          customAutomationHistoryAccess(auth, 'task'),
        ),
      )
      .limit(1);

    if (!task) {
      const userId = auth.userId;
      if (userId && z.string().uuid().safeParse(taskId).success) {
        const [conversation] = await db
          .select({ id: fastAgentConversations.id })
          .from(fastAgentConversations)
          .where(
            and(
              eq(fastAgentConversations.id, taskId),
              customAutomationHistoryAccess(auth, 'fast'),
            ),
          )
          .limit(1);
        if (!conversation) return c.json({ error: 'Task not found' }, 404);
        const result = await getFastSessionMessagesForUser({
          sessionId: taskId,
          userId,
          limit,
          order,
          cursor: cursorValue,
          target: { kind: 'task', id: taskId },
        });
        if (result && 'invalidCursor' in result) {
          return c.json({ error: 'cursor is invalid for this task' }, 400);
        }
        if (result) return c.json(result);
      }
      return c.json({ error: 'Task not found' }, 404);
    }

    const cursor =
      cursorValue !== undefined
        ? decodeMessageHistoryCursor({
            value: cursorValue,
            target: { kind: 'task', id: taskId },
            order,
          })
        : null;
    if (cursorValue !== undefined && !cursor) {
      return c.json({ error: 'cursor is invalid for this task' }, 400);
    }
    if (cursor && !(await validateTaskCursor(taskId, cursor))) {
      return c.json({ error: 'cursor is invalid for this task' }, 400);
    }

    return c.json(await getTaskMessagePage({ taskId, limit, order, cursor }));
  } catch (error) {
    logHandlerError('getTaskMessages', error);
    return c.json({ error: 'Failed to get task messages' }, 500);
  }
}

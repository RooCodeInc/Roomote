import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentMessages,
  inArray,
  sql,
} from '@roomote/db/server';
import {
  canUserAccessFastAgentSession,
  queueFastAgentSurfaceReply,
} from '@roomote/sdk/server';
import { type RoomoteTranscriptMessagesResponse } from '@roomote/types';
import { z } from 'zod';

import {
  collectMessagePage,
  coverageForMessages,
  snapshotForMessageRow,
  type MessageHistoryRow,
} from './message-history-serialization';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
  type MessageHistoryCursor,
  type MessageHistoryPosition,
  type MessageHistorySnapshot,
  type MessageHistoryTarget,
} from './message-history-pagination';

const canonicalFastSessionIdSchema = z.string().uuid();

export async function getFastSessionMessagesForUser(params: {
  sessionId: string;
  userId: string;
  limit?: number;
  order: 'asc' | 'desc';
  cursor?: string;
  target?: MessageHistoryTarget;
}): Promise<
  RoomoteTranscriptMessagesResponse | null | { invalidCursor: true }
> {
  if (!canonicalFastSessionIdSchema.safeParse(params.sessionId).success) {
    return null;
  }
  const fastConversationId = params.sessionId;
  if (
    !(await canUserAccessFastAgentSession({
      sessionId: fastConversationId,
      userId: params.userId,
    }))
  ) {
    return null;
  }

  const target = params.target ?? { kind: 'session', id: params.sessionId };
  const cursor =
    params.cursor !== undefined
      ? decodeMessageHistoryCursor({
          value: params.cursor,
          target,
          order: params.order,
        })
      : null;
  if (params.cursor !== undefined && !cursor) return { invalidCursor: true };
  if (cursor && cursor.position.turnSeq === undefined) {
    return { invalidCursor: true };
  }

  const snapshot =
    cursor?.snapshot ?? (await getFastSessionSnapshot(params.sessionId));
  if (!snapshot) {
    return {
      messages: [],
      returned: 0,
      order: params.order,
      hasMore: false,
      nextCursor: null,
      truncated: false,
      hasNewer: false,
      coverage: coverageForMessages([], false),
    };
  }
  if (cursor && !(await validateFastSessionCursor(params.sessionId, cursor))) {
    return { invalidCursor: true };
  }

  const orderBy =
    params.order === 'desc'
      ? [
          desc(fastAgentMessages.ts),
          desc(fastAgentMessages.turnSeq),
          desc(fastAgentMessages.createdAt),
          desc(fastAgentMessages.id),
        ]
      : [
          asc(fastAgentMessages.ts),
          asc(fastAgentMessages.turnSeq),
          asc(fastAgentMessages.createdAt),
          asc(fastAgentMessages.id),
        ];

  const limit = params.limit ?? 100;
  const selectRows = (
    position: MessageHistoryPosition | null,
    batchSize: number,
  ) => {
    const conditions = [
      eq(fastAgentMessages.conversationId, fastConversationId),
      sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
      fastSnapshotCondition(snapshot, fastConversationId),
      ...(position
        ? [fastPositionCondition(position, fastConversationId, params.order)]
        : []),
    ];
    return db
      .select({
        id: fastAgentMessages.id,
        taskId: fastAgentMessages.conversationId,
        ts: fastAgentMessages.ts,
        turnSeq: fastAgentMessages.turnSeq,
        eventType: fastAgentMessages.eventType,
        role: fastAgentMessages.role,
        contentBlocks: fastAgentMessages.contentBlocks,
        metadata: fastAgentMessages.metadata,
        payload: fastAgentMessages.payload,
        createdAt: fastAgentMessages.createdAt,
      })
      .from(fastAgentMessages)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(batchSize);
  };

  const page = await collectMessagePage({
    limit,
    initialPosition: cursor?.position ?? null,
    loadRows: async (position, batchSize) =>
      (await selectRows(position, batchSize)) as MessageHistoryRow[],
  });
  const { messages, hasMore, truncated, nextPosition } = page;
  const nextCursor =
    hasMore && nextPosition
      ? encodeMessageHistoryCursor({
          version: 1,
          target,
          order: params.order,
          snapshot,
          position: nextPosition,
        } satisfies MessageHistoryCursor)
      : null;
  const hasNewer = Boolean(
    (
      await db
        .select({ id: fastAgentMessages.id })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, fastConversationId),
            fastNewerThanSnapshotCondition(snapshot, fastConversationId),
          ),
        )
        .limit(1)
    )[0],
  );

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

function fastSnapshotCondition(
  snapshot: MessageHistorySnapshot,
  conversationId: string,
) {
  return sql`(${fastAgentMessages.createdAt}, ${fastAgentMessages.id}) <= (select ${fastAgentMessages.createdAt}, ${fastAgentMessages.id} from ${fastAgentMessages} where ${fastAgentMessages.id} = ${snapshot.id}::uuid and ${fastAgentMessages.conversationId} = ${conversationId}::uuid)`;
}

function fastPositionCondition(
  position: MessageHistoryPosition,
  conversationId: string,
  order: 'asc' | 'desc',
) {
  const anchor = sql`(select ${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id} from ${fastAgentMessages} where ${fastAgentMessages.id} = ${position.id}::uuid and ${fastAgentMessages.conversationId} = ${conversationId}::uuid)`;
  return order === 'desc'
    ? sql`(${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id}) < ${anchor}`
    : sql`(${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id}) > ${anchor}`;
}

function fastNewerThanSnapshotCondition(
  snapshot: MessageHistorySnapshot,
  conversationId: string,
) {
  return sql`(${fastAgentMessages.createdAt}, ${fastAgentMessages.id}) > (select ${fastAgentMessages.createdAt}, ${fastAgentMessages.id} from ${fastAgentMessages} where ${fastAgentMessages.id} = ${snapshot.id}::uuid and ${fastAgentMessages.conversationId} = ${conversationId}::uuid)`;
}

async function getFastSessionSnapshot(
  conversationId: string,
): Promise<MessageHistorySnapshot | null> {
  const [row] = await db
    .select({
      id: fastAgentMessages.id,
      createdAt: fastAgentMessages.createdAt,
    })
    .from(fastAgentMessages)
    .where(eq(fastAgentMessages.conversationId, conversationId))
    .orderBy(desc(fastAgentMessages.createdAt), desc(fastAgentMessages.id))
    .limit(1);
  return row ? snapshotForMessageRow(row) : null;
}

async function validateFastSessionCursor(
  conversationId: string,
  cursor: MessageHistoryCursor,
): Promise<boolean> {
  const ids = [cursor.snapshot.id, cursor.position.id];
  const rows = await db
    .select({ id: fastAgentMessages.id })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        inArray(fastAgentMessages.id, ids),
      ),
    );
  return new Set(rows.map((row) => row.id)).size === new Set(ids).size;
}

export async function sendMessageToFastSessionForUser(params: {
  sessionId: string;
  userId: string;
  message: string;
  images?: string[];
}): Promise<
  | { success: true; result: { sessionId: string; queued: true } }
  | { success: false; status: 404 | 409; error: string }
> {
  if (!canonicalFastSessionIdSchema.safeParse(params.sessionId).success) {
    return { success: false, status: 404, error: 'Task not found' };
  }
  const fastConversationId = params.sessionId;
  if (
    !(await canUserAccessFastAgentSession({
      sessionId: fastConversationId,
      userId: params.userId,
    }))
  ) {
    return { success: false, status: 404, error: 'Task not found' };
  }

  const queued = await queueFastAgentSurfaceReply({
    sessionId: fastConversationId,
    userId: params.userId,
    senderDisplayName: null,
    question: params.message,
    images: params.images,
    currentMessageId: `mcp-${randomUUID()}`,
  });
  if (!queued) {
    return {
      success: false,
      status: 409,
      error: "This session's chat surface is not connected",
    };
  }

  return {
    success: true,
    result: { sessionId: params.sessionId, queued: true },
  };
}

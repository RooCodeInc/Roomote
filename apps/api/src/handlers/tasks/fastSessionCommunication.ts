import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentMessages,
  sessions,
  sql,
} from '@roomote/db/server';
import {
  canUserAccessFastAgentSession,
  queueFastAgentSurfaceReply,
} from '@roomote/sdk/server';
import {
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  getImageUrisFromContentBlocks,
  getTextFromContentBlocks,
  sanitizeEnvelopeFields,
} from '@roomote/types';
import { z } from 'zod';

const canonicalFastSessionIdSchema = z.string().uuid();

async function resolveFastConversationId(sessionId: string) {
  if (!canonicalFastSessionIdSchema.safeParse(sessionId).success) return null;
  const [unifiedSession] = await db
    .select({ fastConversationId: sessions.fastConversationId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return unifiedSession?.fastConversationId ?? sessionId;
}

export async function getFastSessionMessagesForUser(params: {
  sessionId: string;
  userId: string;
  limit?: number;
  order: 'asc' | 'desc';
}) {
  const fastConversationId = await resolveFastConversationId(params.sessionId);
  if (!fastConversationId) return null;
  if (
    !(await canUserAccessFastAgentSession({
      sessionId: fastConversationId,
      userId: params.userId,
    }))
  ) {
    return null;
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
  let query = db
    .select({
      id: fastAgentMessages.id,
      ts: fastAgentMessages.ts,
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, fastConversationId),
        sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    .orderBy(...orderBy);
  if (params.limit) {
    query = query.limit(params.limit) as typeof query;
  }

  const rows = await query;
  return rows.map((row) => {
    const sanitized = sanitizeEnvelopeFields(
      row.eventType,
      row.contentBlocks,
      row.metadata,
      row.payload,
      { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
    );
    return {
      id: row.id,
      taskId: params.sessionId,
      ts: Number(row.ts),
      eventType: row.eventType,
      role: row.role,
      text: getTextFromContentBlocks(sanitized.contentBlocks),
      images: getImageUrisFromContentBlocks(sanitized.contentBlocks),
      metadata: sanitized.metadata,
      visibleInTranscript: true,
    };
  });
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
  const fastConversationId = await resolveFastConversationId(params.sessionId);
  if (!fastConversationId) {
    return { success: false, status: 404, error: 'Task not found' };
  }
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
      error: "This Fast session's chat surface is not connected",
    };
  }

  return {
    success: true,
    result: { sessionId: params.sessionId, queued: true },
  };
}

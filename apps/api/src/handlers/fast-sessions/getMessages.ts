import type { Context } from 'hono';

import { and, db, desc, eq, fastAgentMessages, sql } from '@roomote/db/server';
import { canUserAccessFastAgentSession } from '@roomote/sdk/server';
import {
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  getImageUrisFromContentBlocks,
  getTextFromContentBlocks,
  sanitizeEnvelopeFields,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

export async function getFastSessionMessages(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  if (!auth.userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  const sessionId = c.req.param('sessionId')?.trim();
  if (!sessionId) {
    return c.json({ error: 'sessionId is required' }, 400);
  }

  const parsedLimit = Number(c.req.query('limit') ?? 1000);
  if (!Number.isFinite(parsedLimit)) {
    return c.json({ error: 'limit must be a number' }, 400);
  }
  const limit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 1000);

  try {
    if (
      !(await canUserAccessFastAgentSession({ sessionId, userId: auth.userId }))
    ) {
      return c.json({ error: 'Fast session not found' }, 404);
    }

    const rows = await db
      .select({
        id: fastAgentMessages.id,
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
      .where(
        and(
          eq(fastAgentMessages.conversationId, sessionId),
          sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        ),
      )
      .orderBy(
        desc(fastAgentMessages.ts),
        desc(fastAgentMessages.turnSeq),
        desc(fastAgentMessages.createdAt),
        desc(fastAgentMessages.id),
      )
      .limit(limit);

    const messages = rows.map((row) => {
      const sanitized = sanitizeEnvelopeFields(
        row.eventType,
        row.contentBlocks,
        row.metadata,
        row.payload,
        { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
      );
      return {
        id: row.id,
        sessionId,
        ts: Number(row.ts),
        eventType: row.eventType,
        role: row.role,
        text: getTextFromContentBlocks(sanitized.contentBlocks),
        images: getImageUrisFromContentBlocks(sanitized.contentBlocks),
        metadata: sanitized.metadata,
        visibleInTranscript: true,
      };
    });

    return c.json({ messages, returned: messages.length });
  } catch (error) {
    logHandlerError('getFastSessionMessages', error);
    return c.json({ error: 'Failed to get Fast session messages' }, 500);
  }
}

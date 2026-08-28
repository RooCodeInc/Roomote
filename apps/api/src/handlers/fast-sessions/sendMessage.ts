import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

import {
  canUserAccessFastAgentSession,
  queueFastAgentSurfaceReply,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

export async function sendFastSessionMessage(
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

  let body: { message?: unknown };
  try {
    body = (await c.req.json()) as { message?: unknown };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  try {
    if (
      !(await canUserAccessFastAgentSession({ sessionId, userId: auth.userId }))
    ) {
      return c.json({ error: 'Fast session not found' }, 404);
    }

    const queued = await queueFastAgentSurfaceReply({
      sessionId,
      userId: auth.userId,
      senderDisplayName: null,
      question: body.message,
      currentMessageId: `mcp-${randomUUID()}`,
    });
    if (!queued) {
      return c.json(
        { error: "This Fast session's chat surface is not connected" },
        409,
      );
    }

    return c.json({ success: true, sessionId });
  } catch (error) {
    logHandlerError('sendFastSessionMessage', error);
    return c.json({ error: 'Failed to send Fast session message' }, 500);
  }
}

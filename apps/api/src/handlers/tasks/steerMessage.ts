import type { Context } from 'hono';

import type { Variables } from '../../types';
import { resolveMcpTaskOrSessionUserId, type McpAuth } from '../mcp/middleware';
import { steerMessageToTask } from './sendMessageToTask';
import { sendMessageToFastSessionForUser } from './fastSessionCommunication';

/**
 * POST /api/tasks/:taskId/steer_message
 *
 * Send a follow-up message to a running Roomote task, steering when possible.
 */
export async function steerMessage(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const requestAuth = c.get('mcpAuth');
  const auth = {
    ...requestAuth,
    userId: await resolveMcpTaskOrSessionUserId(requestAuth),
  };

  if (!auth.userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  let body: {
    message: string;
    images?: string[];
    clientMessageId?: string;
    senderMode?: 'fast_agent';
  };

  try {
    body = (await c.req.json()) as {
      message: string;
      images?: string[];
      clientMessageId?: string;
      senderMode?: 'fast_agent';
    };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.message?.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  if (
    body.clientMessageId !== undefined &&
    typeof body.clientMessageId !== 'string'
  ) {
    return c.json({ error: 'clientMessageId is invalid' }, 400);
  }

  if (body.senderMode !== undefined && body.senderMode !== 'fast_agent') {
    return c.json({ error: 'senderMode is invalid' }, 400);
  }

  let result = await steerMessageToTask({
    taskId,
    userId: auth.userId,
    message: body.message,
    images: body.images,
    clientMessageId: body.clientMessageId?.trim() || undefined,
    senderMode: body.senderMode,
  });

  if (!result.success && result.status === 404) {
    result = await sendMessageToFastSessionForUser({
      sessionId: taskId,
      userId: auth.userId,
      message: body.message,
      images: body.images,
    });
  }

  if (result.success) {
    return c.json(result);
  }

  const { status, ...errorBody } = result;
  return c.json(errorBody, { status });
}

import type { Context } from 'hono';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
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
  const auth = c.get('mcpAuth');

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
    senderMode?: 'fast_agent';
  };

  try {
    body = (await c.req.json()) as {
      message: string;
      images?: string[];
      senderMode?: 'fast_agent';
    };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.message?.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  if (body.senderMode !== undefined && body.senderMode !== 'fast_agent') {
    return c.json({ error: 'senderMode is invalid' }, 400);
  }

  let result = await steerMessageToTask({
    taskId,
    userId: auth.userId,
    message: body.message,
    images: body.images,
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

import type { Context } from 'hono';
import { isEnvVarRequestFulfillmentClientMessageId } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import {
  type SendMessageSenderMode,
  sendMessageToTask,
} from './sendMessageToTask';
import { sendMessageToFastSessionForUser } from './fastSessionCommunication';

type PublicSendMessageSenderMode = Extract<
  SendMessageSenderMode,
  'authenticated_user' | 'linked_review_handoff'
>;

type SendMessageBody = {
  message: string;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  senderMode?: PublicSendMessageSenderMode;
};

const PUBLIC_SEND_MESSAGE_SENDER_MODES = new Set<PublicSendMessageSenderMode>([
  'authenticated_user',
  'linked_review_handoff',
]);

function parsePublicSenderMode(
  value: unknown,
): PublicSendMessageSenderMode | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value === 'string' &&
    PUBLIC_SEND_MESSAGE_SENDER_MODES.has(value as PublicSendMessageSenderMode)
  ) {
    return value as PublicSendMessageSenderMode;
  }

  return null;
}

function parseOptionalControlString(
  value: unknown,
  options?: {
    rejectEnvVarFulfillmentMarker?: boolean;
  },
): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (
    options?.rejectEnvVarFulfillmentMarker &&
    isEnvVarRequestFulfillmentClientMessageId(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

/**
 * POST /api/tasks/:taskId/send_message
 *
 * Send a follow-up message to a running Roomote task.
 */
export async function sendMessage(
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

  let body: SendMessageBody;

  try {
    body = (await c.req.json()) as SendMessageBody;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.message?.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  const source = parseOptionalControlString(body.source);
  if (source === null) {
    return c.json({ error: 'source is invalid' }, 400);
  }

  const clientMessageId = parseOptionalControlString(body.clientMessageId, {
    rejectEnvVarFulfillmentMarker: true,
  });
  if (clientMessageId === null) {
    return c.json({ error: 'clientMessageId is invalid' }, 400);
  }

  const senderMode = parsePublicSenderMode(body.senderMode);

  if (senderMode === null) {
    return c.json({ error: 'senderMode is invalid' }, 400);
  }

  let result = await sendMessageToTask({
    taskId,
    userId: auth.userId,
    authContext: auth.authContext,
    message: body.message,
    images: body.images,
    source,
    clientMessageId,
    senderMode,
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

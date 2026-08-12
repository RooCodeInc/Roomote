import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { Variables } from '../../types';

import { loadCommunicationLookupTaskRun } from './communication-lookup-run-context';
import { listCommunicationChannels } from './communication-channel-discovery';
import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
} from './communication-message-lookup';
import type { McpAuth } from './middleware';
import { isRunTokenContext, McpProxyError } from './proxy-utils';

type CommunicationMcpVariables = Variables & {
  mcpAuth: McpAuth;
};

function parseMessageContextRequestBody(body: unknown): {
  channel?: string;
  messageId?: string;
  messageLink?: string;
} {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string' ? record.channel.trim() : undefined;
  const messageId =
    typeof record.messageId === 'string' ? record.messageId.trim() : undefined;
  const messageLink =
    typeof record.messageLink === 'string'
      ? record.messageLink.trim()
      : undefined;

  if (!messageId && !messageLink && !channel) {
    throw new Error('messageId, messageLink, or a message link is required');
  }

  return {
    ...(channel ? { channel } : {}),
    ...(messageId ? { messageId } : {}),
    ...(messageLink ? { messageLink } : {}),
  };
}

function parseChannelMessagesRequestBody(body: unknown): {
  channel?: string;
  oldest?: string;
  latest?: string;
} {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string' ? record.channel.trim() : undefined;
  const oldest =
    typeof record.oldest === 'string' ? record.oldest.trim() : undefined;
  const latest =
    typeof record.latest === 'string' ? record.latest.trim() : undefined;
  return {
    ...(channel ? { channel } : {}),
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
  };
}

export const communicationMcp = new Hono<{
  Variables: CommunicationMcpVariables;
}>();

communicationMcp.post('/channels', async (c) => {
  const { authContext } = c.get('mcpAuth');
  if (!isRunTokenContext(authContext)) {
    return c.json(
      { error: 'Communication lookup is only available for task run tokens' },
      403,
    );
  }

  const taskRun = await loadCommunicationLookupTaskRun(authContext.runId);
  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  return c.json(
    await listCommunicationChannels({ actingUserId: taskRun.actingUserId }),
  );
});

communicationMcp.post('/message_context', async (c) => {
  const { authContext } = c.get('mcpAuth');
  if (!isRunTokenContext(authContext)) {
    return c.json(
      { error: 'Communication lookup is only available for task run tokens' },
      403,
    );
  }

  const taskRun = await loadCommunicationLookupTaskRun(authContext.runId);
  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  let parsedBody: ReturnType<typeof parseMessageContextRequestBody>;
  try {
    parsedBody = parseMessageContextRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    return c.json(
      await lookupCommunicationMessageContext({
        ...parsedBody,
        taskRun,
      }),
    );
  } catch (error) {
    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }
    throw error;
  }
});

communicationMcp.post('/channel_messages', async (c) => {
  const { authContext } = c.get('mcpAuth');
  if (!isRunTokenContext(authContext)) {
    return c.json(
      { error: 'Communication lookup is only available for task run tokens' },
      403,
    );
  }

  const taskRun = await loadCommunicationLookupTaskRun(authContext.runId);
  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  let parsedBody: ReturnType<typeof parseChannelMessagesRequestBody>;
  try {
    parsedBody = parseChannelMessagesRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    return c.json(
      await lookupCommunicationChannelMessages({
        ...parsedBody,
        taskRun,
      }),
    );
  } catch (error) {
    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }
    throw error;
  }
});

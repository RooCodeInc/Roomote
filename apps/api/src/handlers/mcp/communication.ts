import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { db, eq, taskRuns } from '@roomote/db/server';

import type { Variables } from '../../types';
import { getTaskChannelBindings } from '../tasks/helpers';

import {
  lookupCommunicationChannelMessages,
  lookupCommunicationThread,
} from './communication-message-lookup';
import type { McpAuth } from './middleware';
import { isRunTokenContext, McpProxyError } from './proxy-utils';

type CommunicationMcpVariables = Variables & {
  mcpAuth: McpAuth;
};

function parseThreadLookupRequestBody(body: unknown): {
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

async function loadLookupRun(runId: number) {
  const run = await db.query.taskRuns.findFirst({
    columns: {
      actingUserId: true,
      taskId: true,
      payload: true,
    },
    where: eq(taskRuns.id, runId),
  });

  if (!run) return null;
  const bindings = await getTaskChannelBindings(run.taskId);
  return {
    actingUserId: run.actingUserId,
    payload: run.payload,
    slackChannelId: bindings?.slackChannelId ?? null,
    slackThreadTs: bindings?.slackThreadTs ?? null,
  };
}

export const communicationMcp = new Hono<{
  Variables: CommunicationMcpVariables;
}>();

communicationMcp.post('/thread_lookup', async (c) => {
  const { authContext } = c.get('mcpAuth');
  if (!isRunTokenContext(authContext)) {
    return c.json(
      { error: 'Communication lookup is only available for task run tokens' },
      403,
    );
  }

  const taskRun = await loadLookupRun(authContext.runId);
  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  let parsedBody: ReturnType<typeof parseThreadLookupRequestBody>;
  try {
    parsedBody = parseThreadLookupRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    return c.json(
      await lookupCommunicationThread({
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

  const taskRun = await loadLookupRun(authContext.runId);
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

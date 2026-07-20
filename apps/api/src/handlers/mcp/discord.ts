import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { db, eq, taskRuns } from '@roomote/db/server';

import type { Variables } from '../../types';

import {
  lookupDiscordChannelMessages,
  lookupDiscordThread,
} from './discord-thread-lookup';
import type { McpAuth } from './middleware';
import { isRunTokenContext, McpProxyError } from './proxy-utils';

type DiscordMcpVariables = Variables & {
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
    throw new Error(
      'messageId, messageLink, or channel (as a Discord message link) is required',
    );
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

export const discordMcp = new Hono<{ Variables: DiscordMcpVariables }>();

discordMcp.post('/thread_lookup', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Discord thread lookup MCP is only available for task run tokens',
      },
      403,
    );
  }

  const run = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!run) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  let parsedBody: {
    channel?: string;
    messageId?: string;
    messageLink?: string;
  };
  try {
    parsedBody = parseThreadLookupRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    const payload = await lookupDiscordThread({
      ...(parsedBody.channel ? { channel: parsedBody.channel } : {}),
      ...(parsedBody.messageId ? { messageId: parsedBody.messageId } : {}),
      ...(parsedBody.messageLink
        ? { messageLink: parsedBody.messageLink }
        : {}),
      taskRun: {
        payload: run.payload,
        actingUserId: run.actingUserId,
      },
    });
    return c.json(payload);
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

discordMcp.post('/channel_messages', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Discord channel message lookup MCP is only available for task run tokens',
      },
      403,
    );
  }

  const run = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!run) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  let parsedBody: {
    channel?: string;
    oldest?: string;
    latest?: string;
  };
  try {
    parsedBody = parseChannelMessagesRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    const payload = await lookupDiscordChannelMessages({
      ...(parsedBody.channel ? { channel: parsedBody.channel } : {}),
      ...(parsedBody.oldest ? { oldest: parsedBody.oldest } : {}),
      ...(parsedBody.latest ? { latest: parsedBody.latest } : {}),
      taskRun: {
        payload: run.payload,
        actingUserId: run.actingUserId,
      },
    });
    return c.json(payload);
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, db, eq, slackUserMappings } from '@roomote/db/server';
import {
  CHAT_CHANNEL_POST_TOOL_NAME,
  CHAT_CHANNELS_TOOL,
  CHAT_REACTION_EMOJI_TOOL_NAME,
} from '@roomote/types';
import { z } from 'zod';

import { listCommunicationChannels } from './communication-channel-discovery';
import { sendCommunicationChannelPost } from './communication-channel-posts';
import { maybeAddCommunicationReaction } from './communication-thread-replies';
import { toolError } from './in-process-api';
import { toMcpToolResult } from './proxy-utils';

async function responseToToolResult(response: Response) {
  const payload = (await response.json()) as Record<string, unknown>;
  return response.ok
    ? toMcpToolResult(payload)
    : toolError({ ...payload, status: response.status });
}

async function authorizeSlackWorkspace(
  actingUserId: string,
  slackTeamId: string,
) {
  const mapping = await db.query.slackUserMappings.findFirst({
    columns: { id: true },
    where: and(
      eq(slackUserMappings.userId, actingUserId),
      eq(slackUserMappings.slackTeamId, slackTeamId),
    ),
  });
  return mapping
    ? null
    : toolError({
        error: 'Slack workspace is not linked to the acting Roomote member.',
        status: 403,
      });
}

export function registerRoomoteCommunicationTools(
  server: McpServer,
  actingUserId: string,
): void {
  server.registerTool(
    CHAT_CHANNELS_TOOL.name,
    {
      title: CHAT_CHANNELS_TOOL.title,
      description: CHAT_CHANNELS_TOOL.description,
      inputSchema: {
        slackTeamId: z
          .string()
          .min(1)
          .describe('Slack workspace ID to use for channel discovery.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ slackTeamId }) => {
      const accessError = await authorizeSlackWorkspace(
        actingUserId,
        slackTeamId,
      );
      return (
        accessError ??
        toMcpToolResult(
          await listCommunicationChannels({ actingUserId, slackTeamId }),
        )
      );
    },
  );

  server.registerTool(
    CHAT_CHANNEL_POST_TOOL_NAME,
    {
      title: 'Post To Channel',
      description:
        'Post a new standalone Markdown message to an accessible Slack channel. Use send_chat_reply for normal replies in the current conversation. Channel access is verified with the configured Slack installation.',
      inputSchema: {
        provider: z.literal('slack'),
        slackTeamId: z.string().min(1),
        channel: z.string().min(1),
        threadTs: z.string().min(1).optional(),
        text: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ provider, slackTeamId, channel, threadTs, text }) => {
      const accessError = await authorizeSlackWorkspace(
        actingUserId,
        slackTeamId,
      );
      return (
        accessError ??
        responseToToolResult(
          await sendCommunicationChannelPost({
            taskRun: {
              id: 0,
              taskId: `member:${actingUserId}`,
              actingUserId,
              payload: {
                communicationProvider: provider,
                communicationTeamId: slackTeamId,
              },
            },
            parsedBody: {
              channel,
              ...(threadTs ? { threadTs } : {}),
              text,
              images: [],
            },
          }),
        )
      );
    },
  );

  server.registerTool(
    CHAT_REACTION_EMOJI_TOOL_NAME,
    {
      title: 'Send Chat Reaction Emoji',
      description:
        'Add an emoji reaction to the current incoming Slack message. Use only for a lightweight acknowledgement or emoji-only answer when the current turn allows reactions.',
      inputSchema: {
        provider: z.literal('slack'),
        slackTeamId: z.string().min(1),
        channel: z.string().min(1),
        messageId: z.string().min(1),
        name: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ slackTeamId, channel, messageId, name }) => {
      const accessError = await authorizeSlackWorkspace(
        actingUserId,
        slackTeamId,
      );
      if (accessError) return accessError;

      const normalizedName = name.trim().replace(/^:+|:+$/g, '');
      if (!normalizedName || /\s/.test(normalizedName)) {
        return toolError({ error: 'Invalid reaction name.' });
      }
      const response = await maybeAddCommunicationReaction({
        taskRun: {
          id: 0,
          payload: {
            communicationProvider: 'slack',
            communicationTeamId: slackTeamId,
            communicationChannelId: channel,
          },
        },
        parsedBody: {
          channel,
          messageTs: messageId,
          name: normalizedName,
        },
      });
      return response
        ? responseToToolResult(response)
        : toolError({ error: 'Slack reactions are unavailable.' });
    },
  );
}

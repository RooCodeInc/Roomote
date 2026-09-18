import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CHAT_CHANNEL_POST_TOOL_NAME,
  CHAT_CHANNELS_TOOL,
  CHAT_REACTION_EMOJI_TOOL_NAME,
  CHAT_SELF_DIRECT_MESSAGE_TOOL_NAME,
} from '@roomote/types';
import {
  hasUserDirectMessageIdentity,
  sendUserDirectMessage,
} from '@roomote/sdk/server';
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
          .optional()
          .describe('Optional Slack workspace ID to limit channel discovery.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ slackTeamId }) =>
      toMcpToolResult(
        await listCommunicationChannels({ actingUserId, slackTeamId }),
      ),
  );

  server.registerTool(
    CHAT_CHANNEL_POST_TOOL_NAME,
    {
      title: 'Post To Slack Destination',
      description:
        'Post a new standalone Markdown message to an authorized Slack channel, thread, or linked workspace member. For a direct message, use a Slack user ID returned by list_chat_channels, or a user mention or DM ID from trusted context; both the acting member and recipient must have linked accounts in that workspace. Use send_direct_message_to_self for the authenticated member or send_chat_reply for the current conversation. Never infer a recipient ID. Provider and destination access are verified before delivery.',
      inputSchema: {
        provider: z.literal('slack'),
        slackTeamId: z.string().min(1),
        channel: z
          .string()
          .min(1)
          .describe(
            'Slack channel name or ID, linked recipient user ID or mention, or existing DM ID.',
          ),
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
    async ({ provider, slackTeamId, channel, threadTs, text }) =>
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
      ),
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

  server.registerTool(
    CHAT_SELF_DIRECT_MESSAGE_TOOL_NAME,
    {
      title: 'Send Direct Message To Yourself',
      description:
        'Send an exact text direct message to the authenticated Roomote member through their linked Telegram or Slack account. Select one provider per call. If delivery fails, the error identifies the attempted provider so another provider can be tried explicitly. The recipient is always resolved from the authenticated member; arbitrary recipients are not supported.',
      inputSchema: {
        provider: z.enum(['telegram', 'slack']),
        text: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ provider, text }) => {
      if (!(await hasUserDirectMessageIdentity(provider, actingUserId))) {
        return toolError({
          code: 'recipient_not_linked',
          error: `The authenticated Roomote member does not have a linked ${provider} direct-message identity.`,
          provider,
        });
      }

      const delivered = await sendUserDirectMessage({
        provider,
        userId: actingUserId,
        text,
        logContext: 'roomote-mcp-self-direct-message',
      });
      return delivered
        ? toMcpToolResult({ delivered: true, provider })
        : toolError({
            code: 'delivery_failed',
            error: `${provider} direct-message delivery failed; no message was confirmed as sent.`,
            provider,
          });
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CHAT_DESTINATIONS_TOOL,
  CHAT_MESSAGE_SEND_TOOL,
  CHAT_REACTION_EMOJI_TOOL_NAME,
} from '@roomote/types';
import { z } from 'zod';

import { listCommunicationDestinations } from './communication-channel-discovery';
import { sendCommunicationMessage } from './communication-message-send';
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
    CHAT_DESTINATIONS_TOOL.name,
    {
      title: CHAT_DESTINATIONS_TOOL.title,
      description: CHAT_DESTINATIONS_TOOL.description,
      inputSchema: {
        workspaceId: z
          .string()
          .optional()
          .describe(
            'Optional Slack workspace ID to limit channel and linked-person discovery.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) =>
      toMcpToolResult(
        await listCommunicationDestinations({
          actingUserId,
          slackTeamId: workspaceId,
        }),
      ),
  );

  server.registerTool(
    CHAT_MESSAGE_SEND_TOOL.name,
    {
      title: CHAT_MESSAGE_SEND_TOOL.title,
      description: CHAT_MESSAGE_SEND_TOOL.description,
      inputSchema: {
        destination: z
          .string()
          .min(1)
          .describe(CHAT_MESSAGE_SEND_TOOL.inputDescriptions.destination),
        message: z
          .string()
          .min(1)
          .describe(CHAT_MESSAGE_SEND_TOOL.inputDescriptions.message),
        imageArtifactIds: z
          .array(z.string().min(1))
          .optional()
          .describe(CHAT_MESSAGE_SEND_TOOL.inputDescriptions.imageArtifactIds),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ destination, message, imageArtifactIds }) =>
      responseToToolResult(
        await sendCommunicationMessage({
          actingUserId,
          destination,
          message,
          ...(imageArtifactIds ? { imageArtifactIds } : {}),
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
}

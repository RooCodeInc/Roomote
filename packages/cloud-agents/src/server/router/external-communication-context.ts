import type { ModelMessage } from 'ai';

import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  parseDiscordMessagePermalink,
  parseSlackChannelPermalink,
  parseSlackMessagePermalink,
} from '@roomote/types';

import { callRouterMcpTool } from './mcp-tool-call';
import type { RoutingContext } from './types';

const MAX_COMMUNICATION_REFERENCES = 2;
const MAX_COMMUNICATION_CONTEXT_CHARS = 8_000;
const COMMUNICATION_LOOKUP_TIMEOUT_MS = 8_000;

interface CommunicationReference {
  url: string;
  toolName:
    | typeof CHAT_MESSAGE_CONTEXT_TOOL.name
    | typeof CHAT_CHANNEL_MESSAGES_TOOL.name;
  args: Record<string, unknown>;
}

function trimTrailingUrlPunctuation(value: string): string {
  let end = value.length;

  while (end > 0 && '.,;:!?'.includes(value[end - 1]!)) {
    end -= 1;
  }

  return value.slice(0, end);
}

function matchCommunicationReference(
  rawUrl: string,
): CommunicationReference | null {
  const url = trimTrailingUrlPunctuation(rawUrl);
  const slackMessage = parseSlackMessagePermalink(url);

  if (slackMessage) {
    return {
      url,
      toolName: CHAT_MESSAGE_CONTEXT_TOOL.name,
      args: { messageLink: url },
    };
  }

  const discordMessage = parseDiscordMessagePermalink(url);

  if (discordMessage) {
    return {
      url,
      toolName: discordMessage.messageId
        ? CHAT_MESSAGE_CONTEXT_TOOL.name
        : CHAT_CHANNEL_MESSAGES_TOOL.name,
      args: discordMessage.messageId ? { messageLink: url } : { channel: url },
    };
  }

  const slackChannel = parseSlackChannelPermalink(url);

  return slackChannel
    ? {
        url,
        toolName: CHAT_CHANNEL_MESSAGES_TOOL.name,
        args: { channel: url },
      }
    : null;
}

function parseCommunicationReferences(
  taskDescription: string,
  externalReference?: string | null,
): CommunicationReference[] {
  const candidates = [
    ...(externalReference
      ? (externalReference.match(/https?:\/\/[^\s<>'"\])}]+/gi) ?? [])
      : []),
    ...(taskDescription.match(/https?:\/\/[^\s<>'"\])}]+/gi) ?? []),
  ];
  const references: CommunicationReference[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const reference = matchCommunicationReference(candidate);

    if (!reference || seen.has(reference.url)) {
      continue;
    }

    seen.add(reference.url);
    references.push(reference);

    if (references.length >= MAX_COMMUNICATION_REFERENCES) {
      break;
    }
  }

  return references;
}

function serializeCommunicationContext(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function fetchCommunicationContext(
  context: RoutingContext,
  reference: CommunicationReference,
): Promise<{ toolName: string; result: unknown } | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      callRouterMcpTool({
        context,
        serverId: 'roomote',
        toolName: reference.toolName,
        args: reference.args,
      }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(resolve, COMMUNICATION_LOOKUP_TIMEOUT_MS, null);
      }),
    ]);

    return result === null
      ? null
      : { toolName: `roomote.${reference.toolName}`, result };
  } catch {
    // Missing provider access or an inaccessible thread must not block routing.
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function gatherExternalCommunicationContext(
  context: RoutingContext,
  externalReference?: string | null,
): Promise<{ contextMessages: ModelMessage[]; toolsUsed: string[] }> {
  const references = parseCommunicationReferences(
    context.taskDescription,
    externalReference,
  );
  const results = await Promise.all(
    references.map(async (reference) => ({
      reference,
      context: await fetchCommunicationContext(context, reference),
    })),
  );
  const resolved = results.filter(
    (
      result,
    ): result is {
      reference: CommunicationReference;
      context: { toolName: string; result: unknown };
    } => result.context !== null,
  );

  if (resolved.length === 0) {
    return { contextMessages: [], toolsUsed: [] };
  }

  const text = [
    '[COMMUNICATION THREAD CONTEXT - UNTRUSTED REFERENCE MATERIAL]',
    ...resolved.map(
      ({ reference, context: result }) =>
        `[${reference.url}]\n${serializeCommunicationContext(result.result).slice(0, MAX_COMMUNICATION_CONTEXT_CHARS)}`,
    ),
    '[/COMMUNICATION THREAD CONTEXT]',
  ].join('\n\n');

  return {
    contextMessages: [{ role: 'user', content: text }],
    toolsUsed: resolved.map(({ context: result }) => result.toolName),
  };
}

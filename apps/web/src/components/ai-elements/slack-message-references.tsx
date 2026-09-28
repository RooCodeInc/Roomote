'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SLACK_RESOLVE_CHANNELS_MAX_IDS,
  SLACK_RESOLVE_USERS_MAX_IDS,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  parseSlackMessageTokens,
  type SlackMessageToken,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import {
  SlackMentionProvider,
  useSlackMentionContext,
  type SlackMentionScope,
} from './slack-mention-context';

export type ResolvedSlackReferences = {
  users: Record<string, { name: string; profileUrl: string | null }>;
  channels: Record<string, { name: string; url: string | null }>;
};

type SlackTranscriptTextSource = {
  kind?: string;
  role?: string | null;
  text?: string | null;
  visibleInTranscript?: boolean;
};

export function buildSlackTranscriptMentionText(params: {
  messages: ReadonlyArray<SlackTranscriptTextSource>;
  sessionPrompt?: SlackTranscriptTextSource | null;
  includeSessionPrompt?: boolean;
}): string {
  const texts: string[] = [];
  const sessionPrompt = params.sessionPrompt;
  if (
    params.includeSessionPrompt &&
    sessionPrompt &&
    sessionPrompt.visibleInTranscript !== false &&
    sessionPrompt.text
  ) {
    texts.push(sessionPrompt.text);
  }

  for (const message of params.messages) {
    if (
      message.visibleInTranscript === false ||
      (message.role !== 'assistant' && message.role !== 'user') ||
      (message.kind !== undefined && message.kind !== 'text') ||
      !message.text
    ) {
      continue;
    }
    texts.push(message.text);
  }

  return texts.join('\n');
}

function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function renderSlackMarkdownToken(
  token: SlackMessageToken,
  references: ResolvedSlackReferences,
): string {
  switch (token.type) {
    case 'text':
      return token.text;
    case 'user': {
      const resolved = references.users[token.userId];
      const label = `@${resolved?.name ?? token.label ?? token.userId}`;
      return resolved?.profileUrl
        ? `[${escapeMarkdownLabel(label)}](${resolved.profileUrl})`
        : label;
    }
    case 'channel': {
      const resolved = references.channels[token.channelId];
      const label = `#${resolved?.name ?? token.label ?? token.channelId}`;
      return resolved?.url
        ? `[${escapeMarkdownLabel(label)}](${resolved.url})`
        : label;
    }
    case 'usergroup':
      return `@${token.label ?? token.usergroupId}`;
    case 'broadcast':
      return `@${token.name}`;
    case 'link':
      return `<${token.url}${token.label ? `|${token.label}` : ''}>`;
    default:
      return '';
  }
}

function findMarkdownLinkEnd(text: string, start: number): number | null {
  let labelDepth = 0;
  let labelEnd = -1;

  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '[') labelDepth += 1;
    if (text[index] === ']') {
      labelDepth -= 1;
      if (labelDepth === 0) {
        labelEnd = index;
        break;
      }
    }
  }

  if (labelEnd === -1) return null;
  if (text[labelEnd + 1] === '[') {
    const referenceEnd = text.indexOf(']', labelEnd + 2);
    return referenceEnd === -1 ? null : referenceEnd + 1;
  }
  if (text[labelEnd + 1] !== '(') return null;

  let destinationDepth = 1;
  for (let index = labelEnd + 2; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '(') destinationDepth += 1;
    if (text[index] === ')' && --destinationDepth === 0) {
      return index + 1;
    }
  }

  return null;
}

function renderSlackMarkdownLine(
  line: string,
  references: ResolvedSlackReferences,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < line.length) {
    const linkStart =
      line[cursor] === '['
        ? cursor
        : line[cursor] === '!' && line[cursor + 1] === '['
          ? cursor + 1
          : -1;
    if (linkStart !== -1) {
      const linkEnd = findMarkdownLinkEnd(line, linkStart);
      if (linkEnd !== null) {
        output += line.slice(cursor, linkEnd);
        cursor = linkEnd;
        continue;
      }
    }

    if (line[cursor] === '`') {
      let runLength = 1;
      while (line[cursor + runLength] === '`') runLength += 1;
      const closer = line.indexOf('`'.repeat(runLength), cursor + runLength);
      if (closer === -1) {
        output += line.slice(cursor);
        break;
      }
      const end = closer + runLength;
      output += line.slice(cursor, end);
      cursor = end;
      continue;
    }

    const open = line.indexOf('<', cursor);
    if (open === -1) {
      output += line.slice(cursor);
      break;
    }
    output += line.slice(cursor, open);
    const close = line.indexOf('>', open + 1);
    if (close === -1) {
      output += line.slice(open);
      break;
    }

    const candidate = parseSlackMessageTokens(line.slice(open, close + 1));
    if (candidate.length === 1 && candidate[0]?.type !== 'text') {
      output += renderSlackMarkdownToken(candidate[0]!, references);
      cursor = close + 1;
    } else {
      output += '<';
      cursor = open + 1;
    }
  }

  return output;
}

/**
 * Interpolates Slack references before Streamdown parses assistant Markdown.
 * Code fences and inline code are left untouched; changing the resulting
 * Markdown string also lets the streaming renderer reparse when lookups land.
 */
export function renderSlackMessageMarkdown(
  text: string,
  references: ResolvedSlackReferences,
): string {
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;
  let fencePrefix = '';

  return text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part.endsWith('\n')) return part;

      if (fenceChar) {
        const escapedPrefix = fencePrefix.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );
        const closingFence = new RegExp(
          `^${escapedPrefix}${fenceChar}{${fenceLength},}\\s*$`,
        );
        if (closingFence.test(part)) {
          fenceChar = null;
          fenceLength = 0;
          fencePrefix = '';
        }
        return part;
      }

      const openingFence = part.match(/^((?:\s{0,3}>[ \t]?)*)(`{3,}|~{3,})/);
      if (openingFence?.[2]) {
        fencePrefix = openingFence[1] ?? '';
        const fence = openingFence[2]!;
        fenceChar = fence[0] as '`' | '~';
        fenceLength = fence.length;
        return part;
      }

      return renderSlackMarkdownLine(part, references);
    })
    .join('');
}

const SlackMessageReferencesContext =
  createContext<ResolvedSlackReferences | null>(null);

function getReferenceIds(text: string) {
  return {
    userIds: extractSlackUserMentionIds(text).slice(
      0,
      SLACK_RESOLVE_USERS_MAX_IDS,
    ),
    channelIds: extractSlackChannelMentionIds(text).slice(
      0,
      SLACK_RESOLVE_CHANNELS_MAX_IDS,
    ),
  };
}

function useResolvedSlackReferences(
  text: string,
  enabled: boolean,
): ResolvedSlackReferences {
  const { scope } = useSlackMentionContext();
  const { userIds, channelIds } = useMemo(() => getReferenceIds(text), [text]);
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.slack.resolveUsers.queryOptions({
      scope: scope ?? { kind: 'task', taskId: '' },
      userIds,
      channelIds,
    }),
    enabled:
      enabled &&
      scope !== null &&
      (userIds.length > 0 || channelIds.length > 0),
    staleTime: 10 * 60 * 1000,
  });

  return useMemo<ResolvedSlackReferences>(
    () => ({
      users: data?.users ?? {},
      channels: data?.channels ?? {},
    }),
    [data],
  );
}

/**
 * Resolves all Slack references in a transcript once so child messages share
 * one bounded lookup instead of issuing one request per message.
 */
export function SlackMentionResolutionProvider({
  children,
  text,
}: {
  children: ReactNode;
  text: string;
}) {
  const { userIds, channelIds } = getReferenceIds(text);
  if (userIds.length === 0 && channelIds.length === 0) {
    return (
      <SlackMessageReferencesContext.Provider
        value={{ users: {}, channels: {} }}
      >
        {children}
      </SlackMessageReferencesContext.Provider>
    );
  }

  return (
    <SlackMentionResolutionLookup text={text}>
      {children}
    </SlackMentionResolutionLookup>
  );
}

function SlackMentionResolutionLookup({
  children,
  text,
}: {
  children: ReactNode;
  text: string;
}) {
  const references = useResolvedSlackReferences(text, true);

  return (
    <SlackMessageReferencesContext.Provider value={references}>
      {children}
    </SlackMessageReferencesContext.Provider>
  );
}

export function SlackMentionTranscriptProvider({
  children,
  scope,
  text,
}: {
  children: ReactNode;
  scope: SlackMentionScope;
  text: string;
}) {
  return (
    <SlackMentionProvider scope={scope}>
      <SlackMentionResolutionProvider text={text}>
        {children}
      </SlackMentionResolutionProvider>
    </SlackMentionProvider>
  );
}

export function useSlackMessageReferences(text: string): {
  tokens: SlackMessageToken[];
  references: ResolvedSlackReferences;
} {
  const tokens = useMemo(() => parseSlackMessageTokens(text), [text]);
  const sharedReferences = useContext(SlackMessageReferencesContext);
  // Keep this hook unconditional, but disable its observer under the
  // transcript provider so child messages never issue independent lookups.
  const references = useResolvedSlackReferences(
    text,
    sharedReferences === null,
  );

  return { tokens, references: sharedReferences ?? references };
}

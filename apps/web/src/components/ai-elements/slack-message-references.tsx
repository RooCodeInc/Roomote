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

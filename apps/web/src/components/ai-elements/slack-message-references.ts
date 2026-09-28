'use client';

import { useMemo } from 'react';
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

import { useSlackMentionContext } from './slack-mention-context';

export type ResolvedSlackReferences = {
  users: Record<string, { name: string; profileUrl: string | null }>;
  channels: Record<string, { name: string; url: string | null }>;
};

export function useSlackMessageReferences(text: string): {
  tokens: SlackMessageToken[];
  references: ResolvedSlackReferences;
} {
  const tokens = useMemo(() => parseSlackMessageTokens(text), [text]);
  // Resolve at most the first N distinct users and channels; any overflow
  // stays as the readable raw ID rather than failing the whole lookup.
  const userIds = useMemo(
    () =>
      extractSlackUserMentionIds(text).slice(0, SLACK_RESOLVE_USERS_MAX_IDS),
    [text],
  );
  const channelIds = useMemo(
    () =>
      extractSlackChannelMentionIds(text).slice(
        0,
        SLACK_RESOLVE_CHANNELS_MAX_IDS,
      ),
    [text],
  );
  const { scope } = useSlackMentionContext();
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.slack.resolveUsers.queryOptions({
      scope: scope ?? { kind: 'task', taskId: '' },
      userIds,
      channelIds,
    }),
    enabled: scope !== null && (userIds.length > 0 || channelIds.length > 0),
    staleTime: 10 * 60 * 1000,
  });

  const references = useMemo<ResolvedSlackReferences>(
    () => ({
      users: data?.users ?? {},
      channels: data?.channels ?? {},
    }),
    [data],
  );

  return { tokens, references };
}

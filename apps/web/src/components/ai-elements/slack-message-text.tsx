'use client';

import { Fragment, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SLACK_RESOLVE_USERS_MAX_IDS,
  extractSlackUserMentionIds,
  parseSlackMessageTokens,
  type SlackMessageToken,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import { useSlackMentionContext } from './slack-mention-context';

const MENTION_CLASS_NAME =
  'rounded-sm bg-primary/10 px-1 font-medium text-primary';
const MENTION_LINK_CLASS_NAME = `${MENTION_CLASS_NAME} no-underline hover:underline`;

function SlackMention({ label, href }: { label: string; href: string | null }) {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={MENTION_LINK_CLASS_NAME}
        data-testid="slack-mention"
      >
        {label}
      </a>
    );
  }

  return (
    <span className={MENTION_CLASS_NAME} data-testid="slack-mention">
      {label}
    </span>
  );
}

function renderToken(
  token: SlackMessageToken,
  index: number,
  users: Record<string, { name: string; profileUrl: string | null }>,
): ReactNode {
  switch (token.type) {
    case 'text':
      return <Fragment key={index}>{token.text}</Fragment>;
    case 'user': {
      const resolved = users[token.userId];
      const label = resolved?.name ?? token.label ?? token.userId;
      return (
        <SlackMention
          key={index}
          label={`@${label}`}
          href={resolved?.profileUrl ?? null}
        />
      );
    }
    case 'channel':
      return (
        <SlackMention
          key={index}
          label={`#${token.label ?? token.channelId}`}
          href={null}
        />
      );
    case 'usergroup':
      return (
        <SlackMention
          key={index}
          label={`@${token.label ?? token.usergroupId}`}
          href={null}
        />
      );
    case 'broadcast':
      return <SlackMention key={index} label={`@${token.name}`} href={null} />;
    default:
      return null;
  }
}

/**
 * Renders persisted Slack message text with `<@U…>`, `<#C…>`, and `<!…>`
 * tokens shown as readable mentions. User mentions resolve to display names
 * and link to the member's Slack profile; the stored text is never rewritten.
 */
export function SlackMessageText({ text }: { text: string }) {
  const tokens = useMemo(() => parseSlackMessageTokens(text), [text]);
  // Resolve at most the first N distinct users; any overflow stays as the
  // raw token rather than failing the whole lookup.
  const userIds = useMemo(
    () =>
      extractSlackUserMentionIds(text).slice(0, SLACK_RESOLVE_USERS_MAX_IDS),
    [text],
  );
  const { slackTeamId } = useSlackMentionContext();
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.slack.resolveUsers.queryOptions({ teamId: slackTeamId, userIds }),
    enabled: userIds.length > 0,
    staleTime: 10 * 60 * 1000,
  });
  const users = data?.users ?? {};

  if (tokens.length === 1 && tokens[0]?.type === 'text') {
    return <>{text}</>;
  }

  return <>{tokens.map((token, index) => renderToken(token, index, users))}</>;
}

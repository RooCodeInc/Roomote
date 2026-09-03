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

const MENTION_CLASS_NAME = 'font-medium text-primary';
const MENTION_LINK_CLASS_NAME = `${MENTION_CLASS_NAME} no-underline hover:underline`;
const LINK_CLASS_NAME =
  'text-primary underline underline-offset-2 hover:opacity-80';
const BARE_URL_PATTERN = /https?:\/\/[^\s<>]+/g;
const TRAILING_URL_PUNCTUATION = /[.,;:!?)\]]$/;
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[' };

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) {
    if (current === char) count += 1;
  }
  return count;
}

/**
 * Trims sentence punctuation that trails a bare URL. Closing parentheses and
 * brackets stay attached while they balance an opener inside the URL, so
 * `https://en.wikipedia.org/wiki/Function_(mathematics)` keeps its `)`.
 */
function trimTrailingUrlPunctuation(raw: string): string {
  let url = raw;
  while (TRAILING_URL_PUNCTUATION.test(url)) {
    const last = url[url.length - 1] ?? '';
    const opener = CLOSER_TO_OPENER[last];
    if (opener && countChar(url, opener) >= countChar(url, last)) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

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

function SlackLink({ url, label }: { url: string; label: string | null }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={LINK_CLASS_NAME}
      data-testid="slack-link"
    >
      {label ?? url}
    </a>
  );
}

/** Plain text with bare http(s) URLs turned into links. */
function renderTextWithBareUrls(text: string, keyPrefix: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let part = 0;

  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const index = match.index ?? 0;
    const url = trimTrailingUrlPunctuation(match[0]);
    if (index > lastIndex) {
      nodes.push(
        <Fragment key={`${keyPrefix}-${part++}`}>
          {text.slice(lastIndex, index)}
        </Fragment>,
      );
    }
    nodes.push(
      <SlackLink key={`${keyPrefix}-${part++}`} url={url} label={null} />,
    );
    lastIndex = index + url.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-${part++}`}>
        {text.slice(lastIndex)}
      </Fragment>,
    );
  }

  return nodes;
}

function renderToken(
  token: SlackMessageToken,
  index: number,
  users: Record<string, { name: string; profileUrl: string | null }>,
): ReactNode {
  switch (token.type) {
    case 'text':
      return (
        <Fragment key={index}>
          {renderTextWithBareUrls(token.text, index)}
        </Fragment>
      );
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
    case 'link':
      return <SlackLink key={index} url={token.url} label={token.label} />;
    default:
      return null;
  }
}

/**
 * Renders persisted Slack message text with `<@U…>`, `<#C…>`, `<!…>`, and
 * `<url|label>` tokens shown as readable mentions and links, and bare URLs
 * linkified. User mentions resolve to display names and link to the member's
 * Slack profile; the stored text is never rewritten.
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
  const { scope } = useSlackMentionContext();
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.slack.resolveUsers.queryOptions({
      scope: scope ?? { kind: 'task', taskId: '' },
      userIds,
    }),
    enabled: scope !== null && userIds.length > 0,
    staleTime: 10 * 60 * 1000,
  });
  const users = data?.users ?? {};

  return <>{tokens.map((token, index) => renderToken(token, index, users))}</>;
}

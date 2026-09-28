'use client';

import { Fragment, type ReactNode } from 'react';
import type { SlackMessageToken } from '@roomote/types';

import type { ResolvedSlackReferences } from './slack-message-references';
import { useSlackMessageReferences } from './slack-message-references';

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
  { users, channels }: ResolvedSlackReferences,
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
    case 'channel': {
      const resolved = channels[token.channelId];
      const label = resolved?.name ?? token.label ?? token.channelId;
      return (
        <SlackMention
          key={index}
          label={`#${label}`}
          href={resolved?.url ?? null}
        />
      );
    }
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
 * Slack profile, channel mentions resolve to channel names and link to the
 * channel; the stored text is never rewritten.
 */
export function SlackMessageText({ text }: { text: string }) {
  const { tokens, references } = useSlackMessageReferences(text);

  return (
    <>{tokens.map((token, index) => renderToken(token, index, references))}</>
  );
}

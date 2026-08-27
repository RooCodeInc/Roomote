import { Env } from '@roomote/env';

import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
} from './chat-messages';
import { chunkDiscordMessage } from './discord-provider';

export type FastSessionFooterProvider =
  | 'slack'
  | 'discord'
  | 'teams'
  | 'telegram';

export function buildFastSessionUrl(
  provider: FastSessionFooterProvider,
  sessionId: string,
): string {
  const url = new URL(`${Env.R_APP_URL}/sessions/${sessionId}`);
  url.searchParams.set('utm_source', provider);
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', `${provider}.fast_reply`);
  return url.toString();
}

/**
 * The Fast-session variant of the task thread-reply footer: always the plain
 * "Reply or use the web app." shape, linking to the session view.
 */
export function buildFastSessionReplyFooterText(params: {
  provider: FastSessionFooterProvider;
  sessionId: string;
}): string {
  const sessionUrl = buildFastSessionUrl(params.provider, params.sessionId);

  return buildThreadReplyFooterText({
    taskUrl: sessionUrl,
    linkedPrs: [],
    livePreviewUrl: null,
    explicitMentionRequired: false,
    ...(params.provider === 'slack'
      ? { formatLink: (label: string, url: string) => `<${url}|${label}>` }
      : params.provider === 'discord'
        ? {
            formatLink: formatMarkdownLink,
            formatFooterText: (text: string) => `-# ${text}`,
          }
        : { formatLink: formatMarkdownLink }),
  });
}

/**
 * The last Discord chunk of a footer-bearing message with the footer removed,
 * for rewriting that message when the footer relocates to a newer reply.
 */
export function getDiscordFooterlessFinalChunk(params: {
  textWithFooter: string;
  footerText: string;
}): string {
  const finalChunk = chunkDiscordMessage(params.textWithFooter).at(-1) ?? '';

  if (finalChunk === params.footerText) {
    return '';
  }

  const footerSuffix = `\n\n${params.footerText}`;
  return finalChunk.endsWith(footerSuffix)
    ? finalChunk.slice(0, -footerSuffix.length)
    : finalChunk;
}

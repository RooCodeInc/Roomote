import { Env } from '@roomote/env';
import {
  and,
  db,
  eq,
  getSessionForFastConversation,
  isNull,
  sessionTasks,
  tasks,
} from '@roomote/db/server';

import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
  type ThreadReplyLinkedPr,
} from './chat-messages';
import { chunkDiscordMessage } from './discord-provider';
import { resolveThreadReplyFooterContext } from './thread-reply-footer-context';

export type FastSessionFooterProvider =
  | 'slack'
  | 'discord'
  | 'teams'
  | 'telegram';

export type FastSessionPullRequestReference = {
  number: number | null;
  url: string;
  status?: string | null;
};

export type FastSessionReplyFooterContext = {
  linkedPrs: ThreadReplyLinkedPr[];
  livePreviewUrl: string | null;
};

const TERMINAL_PULL_REQUEST_STATUSES = new Set(['closed', 'merged']);

function collectFastSessionLinkedPrs(params: {
  pullRequest?: FastSessionPullRequestReference | null;
  pullRequests?: readonly FastSessionPullRequestReference[];
  linkedPrs?: readonly ThreadReplyLinkedPr[];
}): ThreadReplyLinkedPr[] {
  const directPrs = [
    ...(params.pullRequest ? [params.pullRequest] : []),
    ...(params.pullRequests ?? []),
  ].flatMap((pullRequest) =>
    typeof pullRequest.number === 'number' &&
    !TERMINAL_PULL_REQUEST_STATUSES.has(pullRequest.status ?? '')
      ? [{ prNumber: pullRequest.number, prUrl: pullRequest.url }]
      : [],
  );
  const uniquePrs = new Map<string, ThreadReplyLinkedPr>();

  for (const pullRequest of [...directPrs, ...(params.linkedPrs ?? [])]) {
    uniquePrs.set(pullRequest.prUrl, pullRequest);
  }

  return [...uniquePrs.values()];
}

export async function resolveFastSessionReplyFooterContext(params: {
  sessionId: string;
  pullRequest?: FastSessionPullRequestReference | null;
  pullRequests?: readonly FastSessionPullRequestReference[];
}): Promise<FastSessionReplyFooterContext> {
  const session = await getSessionForFastConversation(db, params.sessionId);
  const linkedTasks = session
    ? await db
        .select({ taskId: sessionTasks.taskId })
        .from(sessionTasks)
        .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
        .where(
          and(eq(sessionTasks.sessionId, session.id), isNull(tasks.deletedAt)),
        )
    : [];
  const contexts = await Promise.all(
    linkedTasks.map(({ taskId }) =>
      resolveThreadReplyFooterContext({
        taskId,
        prRepo: null,
        prNumber: null,
      }),
    ),
  );

  return {
    linkedPrs: collectFastSessionLinkedPrs({
      pullRequest: params.pullRequest,
      pullRequests: params.pullRequests,
      linkedPrs: contexts.flatMap((context) => context.linkedPrs),
    }),
    livePreviewUrl:
      contexts.find((context) => context.livePreviewUrl)?.livePreviewUrl ??
      null,
  };
}

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

export function buildSelectedTaskSessionUrl(params: {
  taskUrl: string;
  sessionId: string;
  taskId: string;
}): string {
  const url = new URL(params.taskUrl);
  url.pathname = `/sessions/${params.sessionId}`;
  url.searchParams.set('task', params.taskId);
  return url.toString();
}

/**
 * The Fast-session variant of the task thread-reply footer: always the plain
 * "Reply or use the web app." shape, linking to the session view.
 */
export function buildFastSessionReplyFooterText(params: {
  provider: FastSessionFooterProvider;
  sessionId: string;
  pullRequest?: FastSessionPullRequestReference | null;
  pullRequests?: readonly FastSessionPullRequestReference[];
  linkedPrs?: readonly ThreadReplyLinkedPr[];
  livePreviewUrl?: string | null;
}): string {
  const sessionUrl = buildFastSessionUrl(params.provider, params.sessionId);

  return buildThreadReplyFooterText({
    taskUrl: sessionUrl,
    linkedPrs: collectFastSessionLinkedPrs(params),
    livePreviewUrl: params.livePreviewUrl,
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

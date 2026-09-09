import { getRedis } from '@roomote/redis';
import { Env } from '@roomote/env';
import {
  and,
  asc,
  db,
  eq,
  isNull,
  sessions,
  sessionTasks,
  tasks,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';

import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
} from './chat-messages';
import { resolveFastSessionReplyFooterContext } from './fast-session-footer';
import {
  resolveSessionRunningTasks,
  resolveThreadReplyFooterContext,
} from './thread-reply-footer-context';

export type ThreadFooterRefreshTarget = {
  provider: CommunicationProvider | 'source-control';
  channelId: string;
  threadId: string;
};

const DUE_KEY = 'thread_footer_refresh:due';

/** The index contains destinations, never historical message ids or bodies. */
export async function scheduleThreadFooterRefresh(
  target: ThreadFooterRefreshTarget,
): Promise<void> {
  await getRedis().zadd(DUE_KEY, Date.now() + 30_000, JSON.stringify(target));
}

/** Atomically claim a bounded, fair batch. Failed attempts become due again. */
export async function claimThreadFooterRefreshTargets(
  limit = 100,
): Promise<ThreadFooterRefreshTarget[]> {
  const values = (await getRedis().eval(
    `local targets = redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
     for _, target in ipairs(targets) do redis.call('zadd', KEYS[1], ARGV[2], target) end
     return targets`,
    1,
    DUE_KEY,
    Date.now(),
    Date.now() + 30_000,
    Math.max(1, Math.min(limit, 100)),
  )) as string[];
  const targets: ThreadFooterRefreshTarget[] = [];
  for (const value of values) {
    try {
      const target = JSON.parse(value) as ThreadFooterRefreshTarget;
      if (
        !['slack', 'discord', 'teams', 'telegram', 'source-control'].includes(
          target.provider,
        ) ||
        typeof target.channelId !== 'string' ||
        typeof target.threadId !== 'string'
      )
        throw new Error('Invalid footer target');
      targets.push(target);
    } catch {
      await getRedis().zrem(DUE_KEY, value);
    }
  }
  return targets;
}

/** Call under the destination lock so a concurrent delivery cannot lose registration. */
export async function forgetThreadFooterRefresh(
  target: ThreadFooterRefreshTarget,
): Promise<void> {
  await getRedis().zrem(DUE_KEY, JSON.stringify(target));
}

/** Only accept the navigation link in a product-generated footer, never body links. */
export function getThreadFooterNavigationUrl(footerText: string): URL | null {
  const link =
    /<([^<>|]+)\|[Ww]eb app>/.exec(footerText)?.[1] ??
    /\[[Ww]eb app\]\(([^)]+)\)/.exec(footerText)?.[1];
  if (!link) return null;
  try {
    const url = new URL(link.replaceAll('&amp;', '&'));
    return url.origin === new URL(Env.R_APP_URL).origin ? url : null;
  } catch {
    return null;
  }
}

/** Re-resolve current state, keeping the carrier's navigation and presentation. */
export async function resolveCurrentThreadFooterText(
  provider: string,
  footerText: string,
): Promise<string | null> {
  const url = getThreadFooterNavigationUrl(footerText);
  if (!url) return null;
  const match = /^\/(sessions|task)\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const id = match[2]!;
  let context;
  if (match[1] === 'sessions') {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });
    if (session && !session.fastConversationId) {
      const linkedTasks = await db
        .select({ taskId: sessionTasks.taskId })
        .from(sessionTasks)
        .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
        .where(
          and(eq(sessionTasks.sessionId, session.id), isNull(tasks.deletedAt)),
        )
        .orderBy(asc(sessionTasks.attachedAt), asc(sessionTasks.taskId));
      const taskIds = linkedTasks.map(({ taskId }) => taskId);
      const contexts = await Promise.all(
        taskIds.map((taskId) =>
          resolveThreadReplyFooterContext({
            taskId,
            prRepo: null,
            prNumber: null,
            includeRunningTasks: false,
          }),
        ),
      );
      context = {
        runningTasks: await resolveSessionRunningTasks(session.id, taskIds),
        linkedPrs: [
          ...new Map(
            contexts
              .flatMap((entry) => entry.linkedPrs)
              .map((pr) => [pr.prUrl, pr]),
          ).values(),
        ],
        livePreviewUrl:
          contexts.find((entry) => entry.livePreviewUrl)?.livePreviewUrl ??
          null,
      };
    } else {
      context = await resolveFastSessionReplyFooterContext({
        sessionId: session?.fastConversationId ?? id,
      });
    }
  } else {
    context = await resolveThreadReplyFooterContext({
      taskId: id,
      prRepo: null,
      prNumber: null,
    });
  }
  return buildThreadReplyFooterText({
    taskUrl: url.toString(),
    ...context,
    explicitMentionRequired: footerText.includes('@-mention'),
    formatLink:
      provider === 'slack'
        ? (label, href) => `<${href}|${label}>`
        : formatMarkdownLink,
    ...(provider === 'discord'
      ? {
          formatFooterText: (text: string) =>
            footerText.startsWith('-# _') ? `-# _${text}_` : `-# ${text}`,
        }
      : provider === 'github'
        ? { formatFooterText: (text: string) => `<sub><em>${text}</em></sub>` }
        : {}),
  });
}

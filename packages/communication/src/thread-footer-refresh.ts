import { getRedis } from '@roomote/redis';
import { Env } from '@roomote/env';
import {
  and,
  asc,
  db,
  eq,
  getSessionForTask,
  inArray,
  isNull,
  or,
  sessions,
  sessionTasks,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';

import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
  type ThreadReplyLinkedPr,
  type ThreadReplyRunningTasks,
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

/**
 * What a refresh pass learned about a destination.
 *
 * - `active`: coding is running or a preview is live; check again soon.
 * - `idle`: nothing is running, but the Session was recently active, so a
 *   task may still start; check again on the slower cadence.
 * - `gone`: the destination unregistered itself (carrier missing, Session
 *   settled, or the footer can no longer be resolved). Nothing to reschedule.
 */
export type ThreadFooterRefreshOutcome = 'active' | 'idle' | 'gone';

const DUE_KEY = 'thread_footer_refresh:due';

export const THREAD_FOOTER_REFRESH_ACTIVE_MS = 30_000;
export const THREAD_FOOTER_REFRESH_IDLE_MS = 5 * 60_000;
/**
 * A claimed target is leased to the running batch. A batch that crashes or
 * outlives the scheduler cadence must not have its targets re-claimed by the
 * next tick, so the lease is longer than any healthy batch.
 */
export const THREAD_FOOTER_REFRESH_CLAIM_LEASE_MS = 5 * 60_000;
/**
 * An idle footer stops refreshing once its Session has been quiet this long.
 * The next reply into the thread re-registers it, so a Session that resumes
 * through chat picks refresh back up; one that resumes only from the web app
 * shows its new activity on the next chat reply.
 */
export const THREAD_FOOTER_SETTLED_AFTER_MS = 6 * 60 * 60_000;

/** The index contains destinations, never historical message ids or bodies. */
export async function scheduleThreadFooterRefresh(
  target: ThreadFooterRefreshTarget,
): Promise<void> {
  await getRedis().zadd(
    DUE_KEY,
    Date.now() + THREAD_FOOTER_REFRESH_ACTIVE_MS,
    JSON.stringify(target),
  );
}

/** Set the next check for a destination that stays registered. */
export async function rescheduleThreadFooterRefresh(
  target: ThreadFooterRefreshTarget,
  outcome: Exclude<ThreadFooterRefreshOutcome, 'gone'>,
): Promise<void> {
  await getRedis().zadd(
    DUE_KEY,
    Date.now() +
      (outcome === 'active'
        ? THREAD_FOOTER_REFRESH_ACTIVE_MS
        : THREAD_FOOTER_REFRESH_IDLE_MS),
    JSON.stringify(target),
  );
}

/**
 * Atomically claim a bounded, fair batch. Claimed targets are leased to this
 * batch; the batch reschedules or forgets each one when it reports, and a
 * target whose refresh threw becomes due again when the lease lapses.
 */
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
    Date.now() + THREAD_FOOTER_REFRESH_CLAIM_LEASE_MS,
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
    /<([^<>|]+)\|(?:Open in Roomote|[Ww]eb app)>/.exec(footerText)?.[1] ??
    /\[(?:Open in Roomote|[Ww]eb app)\]\(([^()]+)\)/.exec(footerText)?.[1];
  if (!link) return null;
  try {
    const url = new URL(link.replaceAll('&amp;', '&'));
    return url.origin === new URL(Env.R_APP_URL).origin ? url : null;
  } catch {
    return null;
  }
}

/** PR links already shown by a footer, in display order. */
export function getThreadFooterPullRequestLinks(
  footerText: string,
): ThreadReplyLinkedPr[] {
  const links: ThreadReplyLinkedPr[] = [];
  for (const match of footerText.matchAll(/<([^<>|]+)\|PR #(\d+)>/g)) {
    links.push({
      prNumber: Number(match[2]),
      prUrl: match[1]!.replaceAll('&amp;', '&'),
    });
  }
  for (const match of footerText.matchAll(/\[PR #(\d+)\]\(([^()]+)\)/g)) {
    links.push({ prNumber: Number(match[1]), prUrl: match[2]! });
  }
  return links;
}

const TERMINAL_PULL_REQUEST_STATUSES = new Set(['closed', 'merged']);

/**
 * A delivery can know about a pull request the database does not link to the
 * Session (an event on a pull request no linked task opened). A refresh only
 * sees database state, so it keeps such links until the database says the
 * pull request is closed or merged, and keeps the posted order stable.
 */
async function mergeCarriedPullRequests(
  footerText: string,
  resolved: ThreadReplyLinkedPr[],
): Promise<ThreadReplyLinkedPr[]> {
  const carried = getThreadFooterPullRequestLinks(footerText);
  if (carried.length === 0) return resolved;
  const resolvedByUrl = new Map(resolved.map((pr) => [pr.prUrl, pr]));
  const unresolved = carried.filter((pr) => !resolvedByUrl.has(pr.prUrl));
  const closed = new Set<string>();
  if (unresolved.length > 0) {
    const known = await db.query.taskPullRequests.findMany({
      columns: { prUrl: true, status: true },
      where: inArray(
        taskPullRequests.prUrl,
        unresolved.map((pr) => pr.prUrl),
      ),
    });
    for (const row of known) {
      if (row.status && TERMINAL_PULL_REQUEST_STATUSES.has(row.status))
        closed.add(row.prUrl);
    }
  }
  const merged = new Map<string, ThreadReplyLinkedPr>();
  for (const pr of carried) {
    const current = resolvedByUrl.get(pr.prUrl);
    if (current) merged.set(pr.prUrl, current);
    else if (!closed.has(pr.prUrl)) merged.set(pr.prUrl, pr);
  }
  for (const pr of resolved) {
    if (!merged.has(pr.prUrl)) merged.set(pr.prUrl, pr);
  }
  return [...merged.values()];
}

export type ThreadFooterActivity = {
  /** Coding is running or a preview is live: the footer can change any moment. */
  active: boolean;
  /** Nothing is running and the Session has been quiet long enough to stop polling. */
  settled: boolean;
};

export function classifyThreadFooterActivity(context: {
  runningTasks?: ThreadReplyRunningTasks | null;
  livePreviewUrl?: string | null;
  /** Session `activityAt` in epoch milliseconds; null when there is no Session. */
  sessionActivityAt?: number | null;
}): ThreadFooterActivity {
  const active =
    (context.runningTasks?.count ?? 0) > 0 || Boolean(context.livePreviewUrl);
  const quietForMs = Date.now() - (context.sessionActivityAt ?? 0);
  return {
    active,
    settled: !active && quietForMs > THREAD_FOOTER_SETTLED_AFTER_MS,
  };
}

export type CurrentThreadFooter = ThreadFooterActivity & { text: string };

/** Re-resolve current state, keeping the carrier's navigation and presentation. */
export async function resolveCurrentThreadFooter(
  provider: string,
  footerText: string,
): Promise<CurrentThreadFooter | null> {
  const url = getThreadFooterNavigationUrl(footerText);
  if (!url) return null;
  const match = /^\/(sessions|task)\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const id = match[2]!;
  let context: {
    runningTasks?: ThreadReplyRunningTasks | null;
    linkedPrs: ThreadReplyLinkedPr[];
    livePreviewUrl: string | null;
    webAppUrl?: string | null;
  };
  let sessionActivityAt: number | null = null;
  if (match[1] === 'sessions') {
    // Session links carry either the Session id or its Fast conversation id.
    const session = await db.query.sessions.findFirst({
      columns: { id: true, fastConversationId: true, activityAt: true },
      where: or(eq(sessions.id, id), eq(sessions.fastConversationId, id)),
    });
    sessionActivityAt = session?.activityAt ?? null;
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
      const [runningTasks, contexts] = await Promise.all([
        resolveSessionRunningTasks(session.id, taskIds),
        Promise.all(
          taskIds.map((taskId) =>
            resolveThreadReplyFooterContext({
              taskId,
              prRepo: null,
              prNumber: null,
              includeRunningTasks: false,
            }),
          ),
        ),
      ]);
      context = {
        runningTasks,
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
    const [taskContext, session] = await Promise.all([
      resolveThreadReplyFooterContext({
        taskId: id,
        prRepo: null,
        prNumber: null,
      }),
      getSessionForTask(db, id),
    ]);
    context = taskContext;
    sessionActivityAt = session?.activityAt ?? null;
  }
  const linkedPrs = await mergeCarriedPullRequests(
    footerText,
    context.linkedPrs,
  );
  const text = buildThreadReplyFooterText({
    taskUrl: url.toString(),
    ...context,
    linkedPrs,
    formatLink:
      provider === 'slack'
        ? (label, href) => `<${href}|${label}>`
        : formatMarkdownLink,
    ...(provider === 'discord'
      ? { formatFooterText: (text: string) => `-# ${text}` }
      : provider === 'github'
        ? { formatFooterText: (text: string) => `<sub>${text}</sub>` }
        : {}),
  });
  return {
    text,
    ...classifyThreadFooterActivity({ ...context, sessionActivityAt }),
  };
}

export async function resolveCurrentThreadFooterText(
  provider: string,
  footerText: string,
): Promise<string | null> {
  return (await resolveCurrentThreadFooter(provider, footerText))?.text ?? null;
}

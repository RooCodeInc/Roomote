import { createHash } from 'node:crypto';

import { acquireRedisLock, getRedis } from '@roomote/redis';

import type { SlackNotifier } from './slack-notifier';

const SLACK_AGENT_SESSION_TITLE_MAX_CHARS = 200;
const SLACK_AGENT_SESSION_TITLE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SLACK_AGENT_SESSION_TITLE_PENDING_TTL_SECONDS = 60 * 60;
const SLACK_AGENT_SESSION_TITLE_REJECTED_TTL_SECONDS = 60 * 60;
const SLACK_AGENT_SESSION_TITLE_LOCK_RETRY_MS = 100;
const SLACK_AGENT_SESSION_TITLE_LOCK_MAX_ATTEMPTS = 50;
const SLACK_AGENT_SESSION_TITLE_LOCK_RENEW_SECONDS = 60;
const DELETE_PENDING_TITLE_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;

export function normalizeSlackAgentSessionTitle(
  title: string | null | undefined,
): string | undefined {
  if (!title) return undefined;

  const normalized = title
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;

  return Array.from(normalized)
    .slice(0, SLACK_AGENT_SESSION_TITLE_MAX_CHARS)
    .join('');
}

export async function syncSlackAgentSessionTitleBestEffort({
  slack,
  workspaceId,
  channel,
  threadTs,
  title,
  reportedTitle,
  resolveTitle,
}: {
  slack: Pick<SlackNotifier, 'renameAgentSession'>;
  workspaceId: string;
  channel: string;
  threadTs: string;
  title: string | null | undefined;
  reportedTitle?: string;
  resolveTitle?: () => Promise<string | null | undefined>;
}): Promise<void> {
  const normalizedTitle = normalizeSlackAgentSessionTitle(title);
  if (!normalizedTitle) return;

  const sessionKey = `${workspaceId}:${channel}:${threadTs}`;
  const keyHash = createHash('sha256').update(sessionKey).digest('hex');
  const cacheKey = `slack:agent-session-title:${keyHash}`;
  const pendingKey = `${cacheKey}:pending`;
  let release: Awaited<ReturnType<typeof acquireRedisLock>> = null;

  try {
    const redis = getRedis();
    if (
      resolveTitle &&
      normalizeSlackAgentSessionTitle(await resolveTitle()) !== normalizedTitle
    ) {
      return;
    }
    await redis.set(
      pendingKey,
      normalizedTitle,
      'EX',
      SLACK_AGENT_SESSION_TITLE_PENDING_TTL_SECONDS,
    );

    for (
      let attempt = 0;
      attempt < SLACK_AGENT_SESSION_TITLE_LOCK_MAX_ATTEMPTS && !release;
      attempt += 1
    ) {
      release = await acquireRedisLock(`${cacheKey}:lock`, {
        redis,
        ttlSeconds: 30,
      });
      if (
        !release &&
        attempt + 1 < SLACK_AGENT_SESSION_TITLE_LOCK_MAX_ATTEMPTS
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, SLACK_AGENT_SESSION_TITLE_LOCK_RETRY_MS),
        );
      }
    }
    if (!release) return;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (
        !(await release.renew(SLACK_AGENT_SESSION_TITLE_LOCK_RENEW_SECONDS))
      ) {
        return;
      }
      const pendingTitle = normalizeSlackAgentSessionTitle(
        await redis.get(pendingKey),
      );
      if (!pendingTitle) return;
      if (resolveTitle) {
        const latestTitle = normalizeSlackAgentSessionTitle(
          await resolveTitle(),
        );
        if (latestTitle !== pendingTitle) {
          if (latestTitle) {
            await redis.set(
              pendingKey,
              latestTitle,
              'EX',
              SLACK_AGENT_SESSION_TITLE_PENDING_TTL_SECONDS,
            );
          } else {
            await redis.eval(
              DELETE_PENDING_TITLE_SCRIPT,
              1,
              pendingKey,
              pendingTitle,
            );
          }
          continue;
        }
      }
      const pendingTitleHash = createHash('sha256')
        .update(pendingTitle)
        .digest('hex');
      const rejectedKey = `${cacheKey}:rejected:${pendingTitleHash}`;

      if ((await redis.get(cacheKey)) !== pendingTitleHash) {
        const reported = normalizeSlackAgentSessionTitle(reportedTitle);
        let synchronized =
          pendingTitle === normalizedTitle && reported === pendingTitle;
        if (!synchronized) {
          if (await redis.get(rejectedKey)) {
            await redis.eval(
              DELETE_PENDING_TITLE_SCRIPT,
              1,
              pendingKey,
              pendingTitle,
            );
            if (!(await redis.get(pendingKey))) return;
            continue;
          }

          const renameResult = await slack.renameAgentSession({
            channel,
            threadTs,
            title: pendingTitle,
          });
          synchronized = renameResult.ok;
          if (!renameResult.ok && renameResult.error === 'invalid_name') {
            await redis.set(
              rejectedKey,
              '1',
              'EX',
              SLACK_AGENT_SESSION_TITLE_REJECTED_TTL_SECONDS,
            );
          }
        }
        if (!synchronized) return;

        await redis.set(
          cacheKey,
          pendingTitleHash,
          'EX',
          SLACK_AGENT_SESSION_TITLE_CACHE_TTL_SECONDS,
        );
      }

      await redis.eval(
        DELETE_PENDING_TITLE_SCRIPT,
        1,
        pendingKey,
        pendingTitle,
      );
      if (!(await redis.get(pendingKey))) return;
    }
  } catch (error) {
    console.warn(
      `[syncSlackAgentSessionTitle] Failed for workspace=${workspaceId} channel=${channel} thread=${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await release?.();
  }
}

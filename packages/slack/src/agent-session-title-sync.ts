import { createHash } from 'node:crypto';

import { acquireRedisLock, getRedis } from '@roomote/redis';

import type { SlackNotifier } from './slack-notifier';

const SLACK_AGENT_SESSION_TITLE_MAX_CHARS = 200;
const SLACK_AGENT_SESSION_TITLE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SLACK_AGENT_SESSION_TITLE_LOCK_RETRY_MS = 100;
const SLACK_AGENT_SESSION_TITLE_LOCK_MAX_ATTEMPTS = 50;

export function normalizeSlackAgentSessionTitle(
  title: string | null | undefined,
): string | undefined {
  return title?.trim()
    ? title.slice(0, SLACK_AGENT_SESSION_TITLE_MAX_CHARS)
    : undefined;
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
  const titleHash = createHash('sha256').update(normalizedTitle).digest('hex');
  const cacheKey = `slack:agent-session-title:${keyHash}`;
  let release: Awaited<ReturnType<typeof acquireRedisLock>> = null;

  try {
    const redis = getRedis();
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
    if ((await redis.get(cacheKey)) === titleHash) return;
    if (
      resolveTitle &&
      normalizeSlackAgentSessionTitle(await resolveTitle()) !== normalizedTitle
    ) {
      return;
    }

    const reported = normalizeSlackAgentSessionTitle(reportedTitle);
    const synchronized =
      reported === normalizedTitle ||
      (await slack.renameAgentSession({
        channel,
        threadTs,
        title: normalizedTitle,
      }));
    if (!synchronized) return;

    await redis.set(
      cacheKey,
      titleHash,
      'EX',
      SLACK_AGENT_SESSION_TITLE_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    console.warn(
      `[syncSlackAgentSessionTitle] Failed for workspace=${workspaceId} channel=${channel} thread=${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await release?.();
  }
}

import { getRedis } from '@roomote/redis';
import {
  scheduleThreadFooterRefresh,
  type ThreadReplyFooterLock,
} from '@roomote/communication';
import type { FastAgentSourceControlConversation } from '@roomote/types';

const THREAD_COMMENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export type SourceControlFooterRecord = {
  conversation: FastAgentSourceControlConversation;
  sessionId: string;
  messageId: string;
  body: string;
  footerText: string;
};

export function sourceControlFooterTarget(
  conversation: FastAgentSourceControlConversation,
) {
  return {
    provider: 'source-control' as const,
    channelId: JSON.stringify([
      conversation.surface,
      conversation.workspaceId,
      conversation.conversationId,
    ]),
    threadId: conversation.replyTarget.threadId?.split(':')[0] ?? 'root',
  };
}

export async function getSourceControlFooterRecord(
  channelId: string,
  threadId: string,
): Promise<SourceControlFooterRecord | null> {
  const raw = await getRedis().get(
    `source_control:footer:${channelId}:${threadId}`,
  );
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SourceControlFooterRecord;
    return typeof record.messageId === 'string' &&
      typeof record.body === 'string' &&
      typeof record.footerText === 'string' &&
      typeof record.sessionId === 'string' &&
      record.conversation
      ? record
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns false when the supplied lease no longer owns the destination lock,
 * or when a `keepTtl` write found no record to update (it expired since it
 * was read). Ownership and the write happen in one Redis operation, so a
 * lease that lapses after `assertLock` cannot repoint a newer carrier.
 */
export async function setSourceControlFooterRecord(
  record: SourceControlFooterRecord,
  options: { keepTtl?: boolean; lock?: ThreadReplyFooterLock } = {},
): Promise<boolean> {
  const target = sourceControlFooterTarget(record.conversation);
  const key = `source_control:footer:${target.channelId}:${target.threadId}`;
  const value = JSON.stringify(record);
  const redis = getRedis();
  let written: boolean;
  if (options.lock) {
    written =
      (await redis.eval(
        `if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
         if ARGV[3] == 'keepTtl' then
           if not redis.call('set', KEYS[2], ARGV[2], 'KEEPTTL', 'XX') then return 0 end
         else
           redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
         end
         return 1`,
        2,
        options.lock.key,
        key,
        options.lock.ownerId,
        value,
        options.keepTtl ? 'keepTtl' : THREAD_COMMENT_TTL_SECONDS,
      )) === 1;
  } else if (options.keepTtl) {
    written = (await redis.set(key, value, 'KEEPTTL', 'XX')) === 'OK';
  } else {
    await redis.set(key, value, 'EX', THREAD_COMMENT_TTL_SECONDS);
    written = true;
  }
  if (written && !options.keepTtl) {
    await scheduleThreadFooterRefresh(target).catch((error) => {
      console.warn(
        '[sourceControlFooter] Failed to schedule footer refresh',
        error,
      );
    });
  }
  return written;
}

export async function clearSourceControlFooterRecord(
  channelId: string,
  threadId: string,
  expected: SourceControlFooterRecord,
): Promise<void> {
  await getRedis().eval(
    "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    1,
    `source_control:footer:${channelId}:${threadId}`,
    JSON.stringify(expected),
  );
}

/**
 * The comment a Session last opened inside a review thread, so later turns
 * that report on the same thread (a delegated task finishing, a pull request
 * opening) extend that comment instead of stacking new ones. The body rides
 * along because providers replace a comment's whole text on edit.
 */
type SourceControlThreadCommentRecord = {
  messageId: string;
  body: string;
};

function getThreadCommentKey(sessionId: string, threadId: string): string {
  return `source_control:thread_comment:${sessionId}:${threadId}`;
}

export async function getSourceControlThreadCommentRecord(
  sessionId: string,
  threadId: string,
): Promise<SourceControlThreadCommentRecord | null> {
  const raw = await getRedis().get(getThreadCommentKey(sessionId, threadId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SourceControlThreadCommentRecord>;
    return typeof parsed.messageId === 'string' &&
      typeof parsed.body === 'string'
      ? { messageId: parsed.messageId, body: parsed.body }
      : null;
  } catch {
    return null;
  }
}

export async function setSourceControlThreadCommentRecord(
  sessionId: string,
  threadId: string,
  record: SourceControlThreadCommentRecord,
): Promise<void> {
  await getRedis().set(
    getThreadCommentKey(sessionId, threadId),
    JSON.stringify(record),
    'EX',
    THREAD_COMMENT_TTL_SECONDS,
  );
}

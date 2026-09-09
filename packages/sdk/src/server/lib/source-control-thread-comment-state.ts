import { getRedis } from '@roomote/redis';
import { scheduleThreadFooterRefresh } from '@roomote/communication';
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

export async function setSourceControlFooterRecord(
  record: SourceControlFooterRecord,
  keepTtl = false,
): Promise<void> {
  const target = sourceControlFooterTarget(record.conversation);
  const key = `source_control:footer:${target.channelId}:${target.threadId}`;
  if (keepTtl) {
    await getRedis().set(key, JSON.stringify(record), 'KEEPTTL', 'XX');
  } else {
    await getRedis().set(
      key,
      JSON.stringify(record),
      'EX',
      THREAD_COMMENT_TTL_SECONDS,
    );
    await scheduleThreadFooterRefresh(target).catch((error) => {
      console.warn(
        '[sourceControlFooter] Failed to schedule footer refresh',
        error,
      );
    });
  }
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

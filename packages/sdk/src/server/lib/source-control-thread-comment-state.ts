import { getRedis } from '@roomote/redis';

const THREAD_COMMENT_TTL_SECONDS = 30 * 24 * 60 * 60;

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

const SLACK_RESUME_LOCK_PREFIX = 'slack:resume-lock:';

/**
 * One lock identity shared by every path that can resume a Slack task.
 * A Slack thread may own multiple tasks, so including the immutable task id
 * prevents unrelated tasks from blocking each other while preserving
 * serialization between competing resume producers for the same task.
 */
export function getSlackResumeLockKey(
  threadTs: string,
  taskId: string,
): string {
  return `${SLACK_RESUME_LOCK_PREFIX}${threadTs}:${encodeURIComponent(taskId)}`;
}

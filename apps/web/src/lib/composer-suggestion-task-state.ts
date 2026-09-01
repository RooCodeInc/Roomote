/** The task fields that matter to a composer suggestion's context block. */
type SuggestionTaskState = {
  taskId: string;
  title?: string | null;
  latestRun?: {
    status?: string | null;
    taskPhase?: string | null;
  } | null;
  artifacts?: ReadonlyArray<unknown> | null;
};

/**
 * A short, order-independent fingerprint of every delegated-task field the
 * suggestion context includes (title, run state, artifact count), used by
 * both the client query key and the server generation cache, so a task
 * finishing, failing, or being renamed while the session is idle refreshes
 * the suggestion without waiting for another assistant message. Empty when there are no
 * tasks so a session without delegations keeps a stable key.
 */
export function computeTaskStateRevision(
  tasks: ReadonlyArray<SuggestionTaskState>,
): string {
  if (tasks.length === 0) {
    return '';
  }

  const input = tasks
    .map(
      (task) =>
        `${task.taskId}:${task.title ?? ''}:${task.latestRun?.status ?? ''}:${task.latestRun?.taskPhase ?? ''}:${task.artifacts?.length ?? 0}`,
    )
    .sort()
    .join('|');

  // djb2 keeps the key short; collisions only cost a stale-but-cached
  // suggestion until the next turn, never a wrong one.
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

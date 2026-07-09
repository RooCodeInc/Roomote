/**
 * Stage 2 interim: runs no longer carry a `linearSessionId` column (channel
 * bindings live on the task row, which the SDK dequeue/resume responses do
 * not expose yet). Linear-triggered snapshot resumes always carry the drained
 * follow-up messages in the payload, and every queued Linear message includes
 * its session id, so the worker derives the session from there.
 *
 * Once the dequeue/resume responses include the task's channel bindings,
 * callers should switch to `task.linearSessionId`.
 */
export function getLinearSessionIdFromResumePayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queuedLinearMessages = (payload as { queuedLinearMessages?: unknown })
    .queuedLinearMessages;

  if (!Array.isArray(queuedLinearMessages)) {
    return null;
  }

  for (const message of queuedLinearMessages) {
    if (message && typeof message === 'object') {
      const sessionId = (message as { sessionId?: unknown }).sessionId;

      if (typeof sessionId === 'string' && sessionId.trim()) {
        return sessionId;
      }
    }
  }

  return null;
}

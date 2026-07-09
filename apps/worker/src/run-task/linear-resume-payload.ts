/**
 * Payload-derived fallback for the Linear session id. Channel bindings live
 * on the task row and are exposed by the SDK dequeue/resume responses as
 * `task.linearSessionId`, which callers should prefer. Linear-triggered
 * snapshot resumes also carry the drained follow-up messages in the payload,
 * and every queued Linear message includes its session id, so this fallback
 * covers payloads that predate the task columns (and callback paths that
 * only receive the cloud job).
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

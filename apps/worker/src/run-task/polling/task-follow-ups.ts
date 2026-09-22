const TASK_FOLLOW_UP_POLL_INTERVAL_MS = 500;

export function createTaskFollowUpInterval(options: {
  drain: () => Promise<void>;
  logger: { warn: (...args: unknown[]) => void };
}): NodeJS.Timeout {
  const drain = () => {
    void options.drain().catch((error: unknown) => {
      options.logger.warn(
        `[task-follow-ups] Failed to drain queued task follow-ups: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  drain();
  return setInterval(drain, TASK_FOLLOW_UP_POLL_INTERVAL_MS);
}

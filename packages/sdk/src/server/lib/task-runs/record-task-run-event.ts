import type {
  RunEventDetails,
  RunEventSource,
  RunEventType,
} from '@roomote/types';
import {
  db,
  recordTaskRunEvent as persistTaskRunEvent,
} from '@roomote/db/server';

export async function recordTaskRunEvent(input: {
  runId: number;
  source: RunEventSource;
  eventType: RunEventType;
  message?: string;
  details?: RunEventDetails;
}): Promise<void> {
  const { runId, ...rest } = input;
  await persistTaskRunEvent(db, { runId: runId, ...rest });
}

/**
 * Durable proof that the worker's poller fetched (and thereby atomically
 * removed) queued messages from the per-run Redis queue. Without this record
 * there is no way to tell, after the sandbox is gone, whether an undelivered
 * message was never popped (poller dead) or popped and then lost. Recorded
 * fire-and-forget: delivery must never fail because the audit write did.
 */
export function recordQueuedMessagesPoppedEvent(input: {
  runId: number;
  provider: string;
  poppedTs: string[];
}): void {
  if (input.poppedTs.length === 0) {
    return;
  }

  void recordTaskRunEvent({
    runId: input.runId,
    source: 'communication_queue',
    eventType: 'decision',
    message: `Worker popped ${input.poppedTs.length} queued ${input.provider} message(s) for delivery.`,
    details: {
      provider: input.provider,
      poppedCount: input.poppedTs.length,
      poppedTs: input.poppedTs,
    },
  }).catch((error: unknown) => {
    console.warn(
      `[recordQueuedMessagesPoppedEvent] Failed to persist popped event for run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

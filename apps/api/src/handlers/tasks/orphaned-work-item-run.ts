import { cancelTaskRunDirect } from '@roomote/db/server';
import { captureTaskSettled } from '@roomote/telemetry/server';

/**
 * Best-effort cancel of a run whose work-item `finalizeWorkItemLaunched` lost
 * the claim fencing guard (the launcher's stale claim was reclaimed while the
 * task was being enqueued), so the run would otherwise keep running unlinked
 * from its work item.
 *
 * Uses the shared pre-sandbox direct cancel (same mechanism as the stop-task
 * fallback and the Telegram cancel button), which also re-derives the owning
 * task's state. Never throws: returns a short human-readable note describing
 * the cancel outcome for the caller's loud warn log.
 */
export async function cancelOrphanedWorkItemRunBestEffort(
  runId: number,
): Promise<string> {
  try {
    const canceled = await cancelTaskRunDirect({
      runId,
      error: 'Canceled: work-item launch finalize lost the claim fencing guard',
    });
    if (canceled) {
      void captureTaskSettled(runId, 'canceled');
    }

    return canceled
      ? 'orphaned run canceled'
      : 'orphaned run cancel did not apply (already started or terminal)';
  } catch (error) {
    return `orphaned run cancel failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

import {
  enqueueSessionWakeupFire,
  fastAgentConversationRepository,
  resolveSessionWakeupNextRun,
  type SessionWakeupFireJob,
} from '@roomote/cloud-agents/server';
import {
  claimSessionWakeupFire,
  getSessionWakeupById,
  listDueSessionWakeups,
  recordSessionWakeupOutcome,
} from '@roomote/db/server';
import {
  FAST_AGENT_SCHEDULED_WAKEUP_EVENT_TYPE,
  type FastAgentScheduledWakeupEvent,
} from '@roomote/types';

import { enqueueFastAgentParentEvent } from './fast-agent-parent-event-queue';

export {
  SESSION_WAKEUP_FIRE_JOB_NAME,
  SESSION_WAKEUP_QUEUE_NAME,
  type SessionWakeupFireJob,
} from '@roomote/cloud-agents/server';

const LOG_PREFIX = '[SessionWakeups]';
/**
 * The recovery sweep re-adds delayed hints for rows due within this window,
 * so a hint lost to a Redis restart shortly before its time still fires on
 * time rather than one sweep late.
 */
export const SESSION_WAKEUP_RECOVERY_LOOKAHEAD_MS = 2 * 60_000;

export type FireSessionWakeupResult =
  | { outcome: 'fired'; eventId: string; nextRunAt: Date | null }
  | { outcome: 'skipped'; reason: string };

/**
 * Fire one occurrence of a wakeup: admit the platform event into the
 * conversation's durable inbox, then claim the occurrence on the row and
 * schedule the next one.
 *
 * The event is admitted before the claim. Its key derives from the wakeup id
 * and run number, so a crash between the two steps leaves a pending event
 * and an unadvanced row; the recovery sweep re-fires, the duplicate
 * admission is a no-op on its key, and the claim then succeeds. The reverse
 * order could lose an occurrence.
 */
export async function fireSessionWakeup(
  job: SessionWakeupFireJob,
): Promise<FireSessionWakeupResult> {
  const row = await getSessionWakeupById(job.wakeupId);
  if (!row) return { outcome: 'skipped', reason: 'Wakeup no longer exists.' };
  if (row.status !== 'active' || !row.nextRunAt) {
    return { outcome: 'skipped', reason: `Wakeup is ${row.status}.` };
  }
  if (row.nextRunAt.getTime() !== job.runAt) {
    return {
      outcome: 'skipped',
      reason: 'Occurrence already advanced past this job.',
    };
  }

  const firedAt = new Date();
  const runNumber = row.runCount + 1;
  const nextRunAt = resolveSessionWakeupNextRun({
    schedule: row.schedule,
    firedAt,
    runCountAfterFire: runNumber,
    maxRuns: row.maxRuns,
    until: row.until,
  });

  const record = await fastAgentConversationRepository.findById({
    id: row.conversationId,
  });
  if (!record) {
    // Claim first so the row does not fire again every sweep, then count
    // the failure so a conversation that stays missing retires the wakeup.
    await claimSessionWakeupFire({
      id: row.id,
      expectedNextRunAt: row.nextRunAt,
      nextRunAt,
      firedAt,
    });
    await recordSessionWakeupOutcome({
      id: row.id,
      status: 'failed',
      error: 'The Fast conversation for this wakeup was not found.',
    });
    if (nextRunAt) {
      await enqueueSessionWakeupFire({
        wakeupId: row.id,
        runAt: nextRunAt.getTime(),
      });
    }
    return { outcome: 'skipped', reason: 'Conversation not found.' };
  }

  const event: FastAgentScheduledWakeupEvent = {
    type: FAST_AGENT_SCHEDULED_WAKEUP_EVENT_TYPE,
    eventId: `${row.id}:${runNumber}`,
    wakeupId: row.id,
    name: row.name,
    prompt: row.prompt,
    runNumber,
    maxRuns: row.maxRuns,
    firedAt: firedAt.toISOString(),
    nextRunAt: nextRunAt?.toISOString() ?? null,
    reportPolicy: row.reportPolicy,
    createdByUserId: row.createdByUserId ?? record.userId ?? '',
  };
  if (!event.createdByUserId) {
    await claimSessionWakeupFire({
      id: row.id,
      expectedNextRunAt: row.nextRunAt,
      nextRunAt: null,
      firedAt,
    });
    await recordSessionWakeupOutcome({
      id: row.id,
      status: 'failed',
      error: 'No user remains to act on this wakeup.',
    });
    return { outcome: 'skipped', reason: 'No acting user.' };
  }

  await enqueueFastAgentParentEvent({
    parent: {
      sessionId: row.conversationId,
      conversation: record.conversation,
    },
    event,
  });

  const claimed = await claimSessionWakeupFire({
    id: row.id,
    expectedNextRunAt: row.nextRunAt,
    nextRunAt,
    firedAt,
  });
  if (!claimed) {
    return {
      outcome: 'skipped',
      reason: 'Another worker claimed this occurrence.',
    };
  }

  if (nextRunAt) {
    await enqueueSessionWakeupFire({
      wakeupId: row.id,
      runAt: nextRunAt.getTime(),
    });
  }

  console.log(
    `${LOG_PREFIX} Fired "${row.name}" (${row.id}) run #${runNumber}; next ${nextRunAt ? nextRunAt.toISOString() : 'none'}.`,
  );
  return { outcome: 'fired', eventId: event.eventId, nextRunAt };
}

/**
 * Recreate delayed hints for active rows that are due or nearly due. Runs on
 * the queue's recovery schedule and at worker start so Redis restarts and
 * lost jobs cannot strand a wakeup; the compare-and-set claim keeps a
 * duplicate hint harmless.
 */
export async function recoverPendingSessionWakeups(
  now = new Date(),
): Promise<number> {
  const rows = await listDueSessionWakeups({
    dueBy: new Date(now.getTime() + SESSION_WAKEUP_RECOVERY_LOOKAHEAD_MS),
  });
  let recovered = 0;
  for (const row of rows) {
    if (!row.nextRunAt) continue;
    try {
      await enqueueSessionWakeupFire({
        wakeupId: row.id,
        runAt: row.nextRunAt.getTime(),
      });
      recovered += 1;
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Failed to re-add hint for wakeup ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return recovered;
}

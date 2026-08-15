// Real-DB coverage for the Brain outbox helpers. The unique(runId) contract
// is load-bearing: finish-run enqueues inside the completion transaction and
// agents write their own narrative through a separate path, so both must
// converge on exactly one memory candidate per completed run.

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import {
  db,
  eq,
  tasks,
  taskRuns,
  taskFactory,
  brainMemoryEvents,
  brainSyncState,
  backfillBrainMemoryEvents,
  claimPendingBrainMemoryEvents,
  markBrainMemoryEvent,
  releaseBrainMemoryEvents,
  maybeEnqueueBrainMemoryEvent,
  saveBrainAgentSummary,
  resetBrainIngestionState,
  upsertBrainSyncState,
} from '../../server';
import type { CreateTaskRun } from '../../types';

const createdTaskIds: string[] = [];

async function makeCompletedRun(completedAt?: Date) {
  const task = await taskFactory.create({ state: 'active' });
  createdTaskIds.push(task.id);

  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      kind: 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'test/repo',
        description: 'brain fixture run',
      } as CreateTaskRun['payload'],
      status: RunStatus.Completed,
      completedAt,
    })
    .returning();

  if (!run) {
    throw new Error('failed to insert fixture run');
  }

  return run;
}

afterEach(async () => {
  await db.delete(brainSyncState);
  await db.delete(brainMemoryEvents);

  for (const taskId of createdTaskIds.splice(0)) {
    await db.delete(taskRuns).where(eq(taskRuns.taskId, taskId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
  }
});

describe('resetBrainIngestionState', () => {
  it('clears collector checkpoints and requeues completed task memories', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);
    const [claimed] = await claimPendingBrainMemoryEvents(db, 10);
    await markBrainMemoryEvent(db, claimed!.id, 'done');
    await upsertBrainSyncState(db, 'granola-meetings', {
      watermark: new Date('2026-08-01T00:00:00Z'),
      backfillCompletedAt: new Date('2026-08-01T01:00:00Z'),
    });

    await resetBrainIngestionState(db);

    const states = await db.select().from(brainSyncState);
    const [event] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(states).toHaveLength(0);
    expect(event).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
    });
  });
});

describe('maybeEnqueueBrainMemoryEvent', () => {
  it('enqueues exactly one pending event per run, idempotently', async () => {
    const run = await makeCompletedRun();

    await maybeEnqueueBrainMemoryEvent(db, run.id);
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const events = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('pending');
  });
});

describe('saveBrainAgentSummary', () => {
  it('creates the outbox row when the run has not finished yet', async () => {
    const run = await makeCompletedRun();

    await saveBrainAgentSummary(db, run.id, 'decided to use X because Y');

    const [event] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(event?.agentSummary).toBe('decided to use X because Y');
    expect(event?.status).toBe('pending');
  });

  it('re-queues an already ingested memory so the richer text replaces it', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);
    const [claimed] = await claimPendingBrainMemoryEvents(db, 10);
    await markBrainMemoryEvent(db, claimed!.id, 'done');

    await saveBrainAgentSummary(db, run.id, 'agent narrative');

    const [event] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(event?.status).toBe('pending');
    expect(event?.attempts).toBe(0);
    expect(event?.agentSummary).toBe('agent narrative');
  });

  it('keeps the summary when the completion path enqueues afterwards', async () => {
    const run = await makeCompletedRun();

    await saveBrainAgentSummary(db, run.id, 'written before finish');
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const events = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(events).toHaveLength(1);
    expect(events[0]?.agentSummary).toBe('written before finish');
  });
});

describe('backfillBrainMemoryEvents', () => {
  it('enqueues completed runs only, idempotently', async () => {
    const completed = await makeCompletedRun();
    const task = await taskFactory.create({ state: 'active' });
    createdTaskIds.push(task.id);
    const [running] = await db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        kind: 'fresh',
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'test/repo',
          description: 'running fixture',
        } as CreateTaskRun['payload'],
        status: RunStatus.Running,
      })
      .returning();

    const first = await backfillBrainMemoryEvents(db);
    const second = await backfillBrainMemoryEvents(db);

    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);

    const completedEvents = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, completed.id));
    const runningEvents = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, running!.id));

    expect(completedEvents).toHaveLength(1);
    expect(runningEvents).toHaveLength(0);
  });
});

describe('claimPendingBrainMemoryEvents', () => {
  it('claims the most recently completed runs first', async () => {
    const oldest = await makeCompletedRun(new Date('2026-08-12T12:00:00Z'));
    const newest = await makeCompletedRun(new Date('2026-08-14T12:00:00Z'));
    const middle = await makeCompletedRun(new Date('2026-08-13T12:00:00Z'));
    await maybeEnqueueBrainMemoryEvent(db, oldest.id);
    await maybeEnqueueBrainMemoryEvent(db, newest.id);
    await maybeEnqueueBrainMemoryEvent(db, middle.id);

    const [claimed] = await claimPendingBrainMemoryEvents(db, 1);

    expect(claimed?.runId).toBe(newest.id);
  });

  it('uses descending run ID to break equal completion times', async () => {
    const completedAt = new Date('2026-08-14T12:00:00Z');
    const first = await makeCompletedRun(completedAt);
    const second = await makeCompletedRun(completedAt);
    await maybeEnqueueBrainMemoryEvent(db, first.id);
    await maybeEnqueueBrainMemoryEvent(db, second.id);

    const [claimed] = await claimPendingBrainMemoryEvents(db, 1);

    expect(claimed?.runId).toBe(Math.max(first.id, second.id));
  });

  it('claims pending events once and increments attempts', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const claimed = await claimPendingBrainMemoryEvents(db, 10);
    const claimedAgain = await claimPendingBrainMemoryEvents(db, 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('processing');
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimedAgain).toHaveLength(0);
  });

  it('returns a failed-then-retried event to pending via mark', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const [claimed] = await claimPendingBrainMemoryEvents(db, 10);
    expect(claimed).toBeDefined();

    await markBrainMemoryEvent(
      db,
      claimed!.id,
      'pending',
      'transient ingest failure',
    );

    const [reclaimed] = await claimPendingBrainMemoryEvents(db, 10);

    expect(reclaimed?.id).toBe(claimed!.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.lastError).toBe('transient ingest failure');
  });
});

describe('stranded claim recovery', () => {
  it('reclaims a processing row whose drainer never marked it', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const [claimed] = await claimPendingBrainMemoryEvents(db, 10);
    expect(claimed?.status).toBe('processing');

    // A drainer that dies mid-batch leaves the row exactly like this. Age it
    // past the reclaim interval rather than waiting fifteen real minutes.
    await db
      .update(brainMemoryEvents)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(brainMemoryEvents.id, claimed!.id));

    const [reclaimed] = await claimPendingBrainMemoryEvents(db, 10);

    expect(reclaimed?.id).toBe(claimed!.id);
    // Attempts keep climbing across reclaims, so a poisonous row still dies.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('leaves a freshly claimed row alone', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);
    await claimPendingBrainMemoryEvents(db, 10);

    expect(await claimPendingBrainMemoryEvents(db, 10)).toHaveLength(0);
  });

  it('hands back released events immediately and refunds the attempt', async () => {
    const run = await makeCompletedRun();
    await maybeEnqueueBrainMemoryEvent(db, run.id);

    const [claimed] = await claimPendingBrainMemoryEvents(db, 10);
    await releaseBrainMemoryEvents(db, [claimed!.id]);

    const [reclaimed] = await claimPendingBrainMemoryEvents(db, 10);

    expect(reclaimed?.id).toBe(claimed!.id);
    // Backpressure is not a failed try: net zero attempts consumed.
    expect(reclaimed?.attempts).toBe(1);
  });

  it('ignores an empty release', async () => {
    await expect(releaseBrainMemoryEvents(db, [])).resolves.toBeUndefined();
  });
});

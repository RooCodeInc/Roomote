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
  brainCollectorItems,
  brainSyncState,
  backfillBrainMemoryEvents,
  claimPendingBrainMemoryEvents,
  markBrainMemoryEvent,
  releaseBrainMemoryEvents,
  maybeEnqueueBrainMemoryEvent,
  saveBrainAgentSummary,
  resetBrainIngestionState,
  canonicalizeBrainCollectorItemSlugs,
  deleteBrainCollectorItems,
  deleteBrainSyncStateFamily,
  getBrainSyncState,
  listBrainCollectorItems,
  listBrainCollectorItemsBefore,
  listBrainCollectorItemsBySlugPrefix,
  seedBrainCollectorItems,
  upsertBrainCollectorItems,
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
  await db.delete(brainCollectorItems);
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
    await upsertBrainCollectorItems(db, 'notion-pages', [
      {
        itemId: 'page-1',
        slug: 'notion/page1',
        lastSeenAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    await resetBrainIngestionState(db);

    const states = await db.select().from(brainSyncState);
    const collectorItems = await db.select().from(brainCollectorItems);
    const [event] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, run.id));

    expect(states).toHaveLength(0);
    expect(collectorItems).toHaveLength(0);
    expect(event).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
    });
  });
});

describe('Brain collector item inventory', () => {
  it('finds only items missing from a completed sweep', async () => {
    await upsertBrainCollectorItems(db, 'notion-pages', [
      {
        itemId: 'still-shared',
        slug: 'notion/stillshared',
        lastSeenAt: new Date('2026-08-14T00:00:00Z'),
      },
      {
        itemId: 'revoked',
        slug: 'notion/revoked',
        lastSeenAt: new Date('2026-08-14T00:00:00Z'),
      },
    ]);
    const sweepStartedAt = new Date('2026-08-15T00:00:00Z');
    await upsertBrainCollectorItems(db, 'notion-pages', [
      {
        itemId: 'still-shared',
        slug: 'notion/stillshared',
        lastSeenAt: sweepStartedAt,
      },
    ]);

    const missing = await listBrainCollectorItemsBefore(
      db,
      'notion-pages',
      sweepStartedAt,
      100,
    );

    expect(missing.map((item) => item.itemId)).toEqual(['revoked']);

    await deleteBrainCollectorItems(db, 'notion-pages', ['revoked']);
    const remaining = await listBrainCollectorItems(db, 'notion-pages', 100);
    expect(remaining.map((item) => item.itemId)).toEqual(['still-shared']);
  });

  it('seeding never overwrites a row the live collector already wrote', async () => {
    const liveSeenAt = new Date('2026-08-15T00:00:00Z');
    await upsertBrainCollectorItems(db, 'slack-public-channels:day-pages', [
      {
        itemId: 'slack/T1/C1/2026-08-13/1-0-2-0',
        slug: 'slack/T1/C1/2026-08-13/1-0-2-0',
        lastSeenAt: liveSeenAt,
      },
    ]);

    await seedBrainCollectorItems(db, 'slack-public-channels:day-pages', [
      {
        itemId: 'slack/T1/C1/2026-08-13/1-0-2-0',
        slug: 'slack/T1/C1/2026-08-13/1-0-2-0',
        lastSeenAt: new Date(0),
      },
      {
        itemId: 'slack/T1/C1/2026-08-12/3-0-4-0',
        slug: 'slack/T1/C1/2026-08-12/3-0-4-0',
        lastSeenAt: new Date(0),
      },
    ]);

    const rows = await listBrainCollectorItems(
      db,
      'slack-public-channels:day-pages',
      100,
    );
    expect(rows.map((row) => [row.itemId, row.lastSeenAt.getTime()])).toEqual([
      ['slack/T1/C1/2026-08-12/3-0-4-0', 0],
      ['slack/T1/C1/2026-08-13/1-0-2-0', liveSeenAt.getTime()],
    ]);
  });

  it('canonicalizes mixed-case rows, merging by freshest lastSeenAt', async () => {
    const fresh = new Date('2026-08-20T12:00:00Z');
    await upsertBrainCollectorItems(db, 'slack-public-channels:day-pages', [
      // A mixed-case row whose lowercase twin already exists with an older
      // timestamp: merge keeps the freshest.
      {
        itemId: 'slack/T1/C1/2026-08-13/1-0-2-0',
        slug: 'slack/T1/C1/2026-08-13/1-0-2-0',
        lastSeenAt: fresh,
      },
      {
        itemId: 'slack/t1/c1/2026-08-13/1-0-2-0',
        slug: 'slack/t1/c1/2026-08-13/1-0-2-0',
        lastSeenAt: new Date(0),
      },
      // A mixed-case row with no twin: simply rewritten.
      {
        itemId: 'slack/T1/C1/2026-08-14/3-0-4-0',
        slug: 'slack/T1/C1/2026-08-14/3-0-4-0',
        lastSeenAt: new Date('2026-08-20T13:00:00Z'),
      },
      // Already canonical: untouched.
      {
        itemId: 'slack/t1/c1/2026-08-15/5-0-6-0',
        slug: 'slack/t1/c1/2026-08-15/5-0-6-0',
        lastSeenAt: new Date('2026-08-20T14:00:00Z'),
      },
    ]);

    const rewritten = await canonicalizeBrainCollectorItemSlugs(
      db,
      'slack-public-channels:day-pages',
    );
    const rows = await listBrainCollectorItems(
      db,
      'slack-public-channels:day-pages',
      100,
    );

    expect(rewritten).toBe(2);
    expect(rows.map((row) => [row.itemId, row.lastSeenAt.getTime()])).toEqual([
      ['slack/t1/c1/2026-08-13/1-0-2-0', fresh.getTime()],
      ['slack/t1/c1/2026-08-14/3-0-4-0', Date.parse('2026-08-20T13:00:00Z')],
      ['slack/t1/c1/2026-08-15/5-0-6-0', Date.parse('2026-08-20T14:00:00Z')],
    ]);

    // Already canonical: the second pass is a no-op.
    expect(
      await canonicalizeBrainCollectorItemSlugs(
        db,
        'slack-public-channels:day-pages',
      ),
    ).toBe(0);
  });

  it('deletes a superseded collector version with its child partitions', async () => {
    await upsertBrainSyncState(db, 'slack-public-channels:entity-timeline-v2', {
      backfillCursor: '{"completed":[]}',
    });
    await upsertBrainSyncState(
      db,
      'slack-public-channels:entity-timeline-v2:T1/C1',
      { watermark: new Date('2026-08-20T00:00:00Z') },
    );
    await upsertBrainSyncState(db, 'slack-public-channels:entity-timeline-v3', {
      backfillCursor: '{"completed":[]}',
    });
    // A different family sharing no prefix boundary stays.
    await upsertBrainSyncState(db, 'slack-public-channels:day-pages:census', {
      backfillCompletedAt: new Date('2026-08-20T00:00:00Z'),
    });

    await deleteBrainSyncStateFamily(
      db,
      'slack-public-channels:entity-timeline-v2',
    );

    expect(
      await getBrainSyncState(db, 'slack-public-channels:entity-timeline-v2'),
    ).toBeNull();
    expect(
      await getBrainSyncState(
        db,
        'slack-public-channels:entity-timeline-v2:T1/C1',
      ),
    ).toBeNull();
    expect(
      await getBrainSyncState(db, 'slack-public-channels:entity-timeline-v3'),
    ).not.toBeNull();
    expect(
      await getBrainSyncState(db, 'slack-public-channels:day-pages:census'),
    ).not.toBeNull();
  });

  it('lists items under a literal slug prefix', async () => {
    await upsertBrainCollectorItems(db, 'slack-public-channels:day-pages', [
      {
        itemId: 'slack/T1/C1/2026-08-13/1-0-2-0',
        slug: 'slack/T1/C1/2026-08-13/1-0-2-0',
        lastSeenAt: new Date('2026-08-15T00:00:00Z'),
      },
      {
        itemId: 'slack/T1/C1/2026-08-14/5-0-6-0',
        slug: 'slack/T1/C1/2026-08-14/5-0-6-0',
        lastSeenAt: new Date('2026-08-15T00:00:00Z'),
      },
      // LIKE metacharacters in the stored id must not widen the prefix.
      {
        itemId: 'slack/T_/C1/2026-08-13/7-0-8-0',
        slug: 'slack/T_/C1/2026-08-13/7-0-8-0',
        lastSeenAt: new Date('2026-08-15T00:00:00Z'),
      },
    ]);

    const day = await listBrainCollectorItemsBySlugPrefix(
      db,
      'slack-public-channels:day-pages',
      'slack/T1/C1/2026-08-13/',
      100,
    );
    expect(day.map((item) => item.itemId)).toEqual([
      'slack/T1/C1/2026-08-13/1-0-2-0',
    ]);

    // An underscore in the requested prefix matches itself, not any char.
    const underscored = await listBrainCollectorItemsBySlugPrefix(
      db,
      'slack-public-channels:day-pages',
      'slack/T_/',
      100,
    );
    expect(underscored.map((item) => item.itemId)).toEqual([
      'slack/T_/C1/2026-08-13/7-0-8-0',
    ]);
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

  it('requeues completed memories for a one-time metadata replay', async () => {
    const completed = await makeCompletedRun();
    await saveBrainAgentSummary(db, completed.id, 'Keep this summary.');
    const [event] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, completed.id));
    await markBrainMemoryEvent(db, event!.id, 'done');

    await backfillBrainMemoryEvents(db, { requeueCompleted: true });

    const [requeued] = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, completed.id));
    expect(requeued).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: null,
      agentSummary: 'Keep this summary.',
    });
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

import { RunStatus, taskMemorySlug } from '@roomote/types';

import {
  brainMemoryEvents,
  brainPageRetirements,
  claimPendingBrainPageRetirements,
  db,
  enqueueTaskMemoryRetirements,
  eq,
  rearmBrainPageRetirement,
  runFactory,
  settleBrainPageRetirement,
  taskFactory,
  taskRuns,
  tasks,
} from '../../server';

describe('Brain page retirements', () => {
  const taskIds: string[] = [];

  afterEach(async () => {
    await db.delete(brainPageRetirements);
    for (const taskId of taskIds.splice(0)) {
      await db.delete(taskRuns).where(eq(taskRuns.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });

  it('snapshots exact task-run slugs and stops queued ingestion', async () => {
    const task = await taskFactory.create();
    taskIds.push(task.id);
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Completed,
    });
    await db.insert(brainMemoryEvents).values({
      runId: run.id,
      status: 'processing',
      agentSummary: 'direct memory',
    });

    await enqueueTaskMemoryRetirements(db, [task.id]);

    await expect(
      db.query.brainMemoryEvents.findFirst({
        where: eq(brainMemoryEvents.runId, run.id),
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      revision: 1,
      agentSummary: null,
      lastError: 'task deleted',
    });
    await expect(
      db.query.brainPageRetirements.findFirst({
        where: eq(brainPageRetirements.slug, taskMemorySlug(task.id, run.id)),
      }),
    ).resolves.toMatchObject({ status: 'pending', revision: 0 });
  });

  it('retries retirement when ingestion writes during a claimed delete', async () => {
    const slug = taskMemorySlug('task-race', 42);
    await db.insert(brainPageRetirements).values({ slug });
    const [claimed] = await claimPendingBrainPageRetirements(db, 1);

    await rearmBrainPageRetirement(db, slug);
    await expect(
      settleBrainPageRetirement(db, claimed!.id, claimed!.revision, 'done'),
    ).resolves.toBe('superseded');

    await expect(
      db.query.brainPageRetirements.findFirst({
        where: eq(brainPageRetirements.slug, slug),
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      revision: 1,
    });
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import {
  db,
  eq,
  inArray,
  runFactory,
  taskRuns,
  tasks,
  type TaskRun,
} from '@roomote/db/server';
import {
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  RunStatus,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import { listOrphanedTaskRuns } from '../orphaned-task-runs';

const execFileAsync = promisify(execFile);

describe('read-only orphan diagnostics (PostgreSQL)', () => {
  const fixtures: TaskRun[] = [];

  async function createRun({
    createdAt = new Date(Date.now() - 60 * 60 * 1000),
    ...overrides
  }: Parameters<typeof runFactory.create>[0] & { createdAt?: Date }) {
    const created = await runFactory.create({
      status: RunStatus.Pending,
      ...overrides,
    });
    const [run] = await db
      .update(taskRuns)
      .set({ createdAt })
      .where(eq(taskRuns.id, created.id))
      .returning();
    if (!run) throw new Error('Failed to prepare orphan fixture');
    fixtures.push(run);
    return run;
  }

  afterEach(async () => {
    if (fixtures.length > 0) {
      await db.delete(taskRuns).where(
        inArray(
          taskRuns.id,
          fixtures.map((run) => run.id),
        ),
      );
      await db.delete(tasks).where(
        inArray(
          tasks.id,
          fixtures.map((run) => run.taskId),
        ),
      );
      fixtures.length = 0;
    }
  });

  it('lists eligible pending and dequeued runs without refreshing their leases', async () => {
    const pending = await createRun({});
    const dequeued = await createRun({
      status: RunStatus.Dequeued,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      dequeuedAt: new Date(
        Date.now() - ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS - 60_000,
      ),
    });
    const excluded = await Promise.all([
      createRun({ cancelRequestedAt: new Date() }),
      createRun({ canceledAt: new Date() }),
      createRun({ taskPhase: WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE }),
      createRun({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
      createRun({ createdAt: new Date() }),
      createRun({ status: RunStatus.Dequeued, dequeuedAt: new Date() }),
      createRun({ status: RunStatus.Running }),
    ]);

    const before = await db
      .select()
      .from(taskRuns)
      .where(
        inArray(
          taskRuns.id,
          fixtures.map((run) => run.id),
        ),
      );
    const first = await listOrphanedTaskRuns();
    const second = await listOrphanedTaskRuns();
    const ids = first.map((run) => run.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(dequeued.id);
    expect(ids.indexOf(dequeued.id)).toBeLessThan(ids.indexOf(pending.id));
    for (const run of excluded) expect(ids).not.toContain(run.id);
    expect(second).toEqual(first);
    expect(first.find((run) => run.id === pending.id)).not.toHaveProperty(
      'payload',
    );
    expect(
      await db
        .select()
        .from(taskRuns)
        .where(
          inArray(
            taskRuns.id,
            fixtures.map((run) => run.id),
          ),
        ),
    ).toEqual(before);
  });

  it('the real listing command observes a row held by another transaction without claiming it', async () => {
    const run = await createRun({});
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.id, run.id))
        .for('update');
      const { stdout } = await execFileAsync(
        'pnpm',
        ['exec', 'tsx', 'scripts/list-orphaned-task-runs.ts'],
        {
          cwd: path.resolve(import.meta.dirname, '../..'),
          env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' },
          timeout: 30_000,
        },
      );
      const rows = JSON.parse(stdout) as {
        id: number;
        status: string;
        dequeuedAt: string | null;
      }[];
      expect(rows.find((row) => row.id === run.id)).toMatchObject({
        status: RunStatus.Pending,
        dequeuedAt: null,
      });
    });
    expect(
      await db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run.id) }),
    ).toEqual(run);
  }, 40_000);
});

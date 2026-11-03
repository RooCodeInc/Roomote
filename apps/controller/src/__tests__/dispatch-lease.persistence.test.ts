import {
  db,
  eq,
  inArray,
  runFactory,
  sql,
  taskRunEvents,
  taskRuns,
  tasks,
  type TaskRun,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createRunToken: vi.fn().mockResolvedValue('fixture-run-token'),
}));

import { BaseController } from '../BaseController';

class DispatchObserver extends BaseController {
  readonly dispatched: number[] = [];

  constructor() {
    super('development');
    this.isRunning = true;
  }

  protected async spawnFreshWorker(run: TaskRun): Promise<void> {
    this.dispatched.push(run.id);
  }

  dispatch(run: TaskRun) {
    return this.spawnWorker(run);
  }
}

describe('controller dispatch lease persistence', () => {
  const ownedTasks: string[] = [];

  afterEach(async () => {
    if (ownedTasks.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, ownedTasks.splice(0)));
    }
  });

  async function fixture(
    status = RunStatus.Dequeued,
    dequeuedAt: Date | null = new Date(),
  ) {
    const run = await runFactory.create({
      vendor: 'docker',
      status,
      dequeuedAt,
    });
    ownedTasks.push(run.taskId);
    return run;
  }

  async function readRun(id: number) {
    const run = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, id),
    });
    if (!run) throw new Error('Owned dispatch fixture disappeared');
    return run;
  }

  async function dispatchDecisions(id: number) {
    const events = await db.query.taskRunEvents.findMany({
      where: eq(taskRunEvents.runId, id),
    });
    return events.filter(
      (event) => event.details?.stage === 'controller_dequeue',
    );
  }

  it.each([
    { label: 'pending', status: RunStatus.Pending, lease: null },
    { label: 'preparing', status: RunStatus.Preparing, lease: null },
    { label: 'recovered', status: RunStatus.Dequeued, lease: new Date() },
    { label: 'legacy null', status: RunStatus.Dequeued, lease: null },
  ])(
    'dispatches concurrent $label snapshots once and suppresses a fresh replay',
    async ({ status, lease }) => {
      const run = await fixture(status, lease);
      const first = new DispatchObserver();
      const second = new DispatchObserver();
      const outcomes = await Promise.all([
        first.dispatch(run),
        second.dispatch({ ...run }),
      ]);

      expect(outcomes.sort()).toEqual([false, true]);
      expect([...first.dispatched, ...second.dispatched]).toEqual([run.id]);
      expect(await dispatchDecisions(run.id)).toHaveLength(1);
      expect(await second.dispatch(await readRun(run.id))).toBe(false);
      expect((await readRun(run.id)).status).toBe(RunStatus.Dequeued);
      expect(await dispatchDecisions(run.id)).toHaveLength(1);
    },
  );

  it('preserves PostgreSQL microsecond leases and advances their Date-visible identity', async () => {
    const run = await fixture();
    await db
      .update(taskRuns)
      .set({ dequeuedAt: sql`TIMESTAMP '2099-01-01 00:00:00.000123'` })
      .where(eq(taskRuns.id, run.id));
    const snapshot = await readRun(run.id);
    const observer = new DispatchObserver();

    expect(await observer.dispatch(snapshot)).toBe(true);
    const claimed = await readRun(run.id);
    expect(claimed.dequeuedAt!.getTime()).toBe(
      snapshot.dequeuedAt!.getTime() + 1,
    );
    expect((await dispatchDecisions(run.id))[0]?.createdAt).toEqual(
      claimed.dequeuedAt,
    );
    expect(await observer.dispatch(snapshot)).toBe(false);
    expect(await observer.dispatch(claimed)).toBe(false);
    expect(observer.dispatched).toEqual([run.id]);
  });

  it('accepts a later persisted recovery lease while preserving its previous decision', async () => {
    const run = await fixture();
    const observer = new DispatchObserver();
    expect(await observer.dispatch(run)).toBe(true);
    const first = await readRun(run.id);
    await db
      .update(taskRuns)
      .set({ dequeuedAt: new Date(first.dequeuedAt!.getTime() + 1_000) })
      .where(eq(taskRuns.id, run.id));
    expect(await observer.dispatch(await readRun(run.id))).toBe(true);
    expect(observer.dispatched).toEqual([run.id, run.id]);
    expect(await dispatchDecisions(run.id)).toHaveLength(2);
  });

  it.each([
    RunStatus.Processing,
    RunStatus.Preparing,
    RunStatus.Running,
    RunStatus.Idle,
  ])(
    'preserves the dispatched worker after it advances to %s',
    async (status) => {
      const run = await fixture();
      const observer = new DispatchObserver();
      expect(await observer.dispatch(run)).toBe(true);
      await db.update(taskRuns).set({ status }).where(eq(taskRuns.id, run.id));

      expect(await observer.dispatch(await readRun(run.id))).toBe(false);
      expect((await readRun(run.id)).status).toBe(status);
      expect(observer.dispatched).toEqual([run.id]);
      expect(await dispatchDecisions(run.id)).toHaveLength(1);
    },
  );

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled])(
    'does not redispatch a %s run',
    async (status) => {
      const run = await fixture(status);
      const observer = new DispatchObserver();
      expect(await observer.dispatch(run)).toBe(false);
      expect((await readRun(run.id)).status).toBe(status);
      expect(await dispatchDecisions(run.id)).toEqual([]);
      expect(observer.dispatched).toEqual([]);
    },
  );

  it('preserves cancel intent written after the dispatch snapshot was read', async () => {
    const run = await fixture();
    await db
      .update(taskRuns)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(taskRuns.id, run.id));
    const observer = new DispatchObserver();
    expect(await observer.dispatch(run)).toBe(false);
    expect((await readRun(run.id)).cancelRequestedAt).toBeInstanceOf(Date);
    expect(await dispatchDecisions(run.id)).toEqual([]);
    expect(observer.dispatched).toEqual([]);
  });
});

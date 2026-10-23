import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  tasks,
  taskRunEvents,
  recordTaskRunLifecycleEvent,
  type TaskRun,
  and,
  inArray,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const { rpcEntered, rpcRelease, rpcFail, finishRun } = vi.hoisted(() => ({
  rpcEntered: vi.fn(),
  rpcRelease: vi.fn(),
  rpcFail: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock(
  '../../../../packages/sdk/src/server/lib/auth/sandbox-server-rpc',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../packages/sdk/src/server/lib/auth/sandbox-server-rpc')
    >()),
    withSandboxServerRpcClient: async () => {
      rpcEntered();
      await new Promise<void>((resolve, reject) => {
        rpcRelease.mockImplementation(resolve);
        rpcFail.mockImplementation(reject);
      });
    },
  }),
);
vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  finishRun,
}));
vi.mock('../monitoring/sentry', () => ({
  captureControllerMessage: vi.fn(),
  captureControllerException: vi.fn(),
}));

import { BaseController } from '../BaseController';
import { findPersistedWorkerBootstrapRestarts } from '../worker-bootstrap-restarts';
import { stopTaskRun } from '../../../../packages/sdk/src/server/lib/task-runs/stop-task-run';
import { findFinishedRunsWithSandbox } from '../../../../apps/bullmq/src/scheduled-jobs/sleep-check';

class Observer extends BaseController {
  constructor() {
    super('development');
  }
  protected async spawnFreshWorker(): Promise<void> {
    throw new Error('No provider dispatch expected');
  }
  observe(run: TaskRun) {
    return this.handleWorkerExitBeforeStart(run, 137);
  }
  scan() {
    return this.failTimedOutWorkerBootstraps();
  }
  recover() {
    return this.recoverPersistedWorkerBootstrapRestarts();
  }
}

describe('bootstrap recovery honors durable terminal cancel intent', () => {
  const ownedTasks: string[] = [];

  afterEach(async () => {
    rpcRelease();
    for (const id of ownedTasks.splice(0)) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  async function fixture() {
    const task = await taskFactory.create();
    ownedTasks.push(task.id);
    return runFactory.create({
      taskId: task.id,
      status: RunStatus.Dequeued,
      machineId: 'controlled-bootstrap-machine',
      vendor: 'roomote',
      sandboxServerUrl: 'http://controlled-sandbox.invalid',
      provisionReadyAt: new Date(Date.now() - 10 * 60_000),
    });
  }

  it('durably cancels a pre-claim worker even when the stop RPC and finalization side effects fail', async () => {
    const run = await fixture();
    const stop = stopTaskRun({ run, terminate: true });
    await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
    const requested = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(requested?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(requested?.canceledAt).toBeNull();

    finishRun.mockRejectedValueOnce(
      new Error('Controlled finalization side-effect failure'),
    );
    const result = await new Observer().observe(run);
    expect(result).toEqual({
      disposition: 'failed',
      classification: 'routine',
      shutdownReason: 'cancel_requested',
    });
    const persisted = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(persisted?.status).toBe(RunStatus.Canceled);
    expect(persisted?.canceledAt).toBeInstanceOf(Date);
    expect(persisted?.completedAt).toBeNull();
    expect(
      (await db.query.tasks.findFirst({ where: eq(tasks.id, run.taskId) }))
        ?.state,
    ).toBe('canceled');
    expect(persisted?.machineId).toBe(run.machineId);
    expect(persisted?.cancelRequestedAt).toEqual(requested?.cancelRequestedAt);
    expect(
      await db.query.taskRunEvents.findMany({
        where: eq(taskRunEvents.runId, run.id),
      }),
    ).toEqual([]);
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id, status: RunStatus.Canceled }),
    );
    expect(
      (
        await findFinishedRunsWithSandbox(new Date(Date.now() + 3 * 60_000))
      ).some((item) => item.id === run.id),
    ).toBe(true);
    rpcFail(new Error('Controlled dead sandbox'));
    await expect(stop).rejects.toThrow('Controlled dead sandbox');
  });

  it('honors cancel intent from another process after a controlled worker SIGKILL', async () => {
    const run = await fixture();
    const observer = fork(
      fileURLToPath(new URL('./bootstrap-cancel.observer.ts', import.meta.url)),
      [String(run.id)],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const worker = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    let stop: ReturnType<typeof stopTaskRun> | undefined;
    try {
      const [ready] = await once(observer, 'message', {
        signal: AbortSignal.timeout(30_000),
      });
      expect(ready).toEqual({ ready: true });
      // The observer has already read its original run. The real SDK writer
      // commits intent independently, before the worker-exit stimulus.
      stop = stopTaskRun({ run, terminate: true });
      await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
      const exit = once(worker, 'exit');
      worker.kill('SIGKILL');
      expect(await exit).toEqual([null, 'SIGKILL']);
      const response = once(observer, 'message', {
        signal: AbortSignal.timeout(30_000),
      });
      observer.send({ exitCode: 137 });
      expect((await response)[0]).toEqual({
        result: {
          disposition: 'failed',
          classification: 'routine',
          shutdownReason: 'cancel_requested',
        },
      });
      const persisted = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, run.id),
      });
      expect(persisted?.status).toBe(RunStatus.Canceled);
      expect(persisted?.canceledAt).toBeInstanceOf(Date);
      expect(persisted?.completedAt).toBeNull();
      expect(persisted?.machineId).toBe(run.machineId);
      expect(persisted?.cancelRequestedAt).toBeInstanceOf(Date);
      expect(
        (
          await db.query.taskRunEvents.findMany({
            where: eq(taskRunEvents.runId, run.id),
          })
        ).some((event) => event.details?.stage === 'worker_bootstrap_restart'),
      ).toBe(false);
    } finally {
      rpcRelease();
      await stop;
      worker.kill('SIGKILL');
      observer.kill('SIGKILL');
    }
  }, 65_000);

  it('does not turn a canceled replacement bootstrap into a failed run', async () => {
    const run = await fixture();
    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: 'Fixture prior retry',
      details: { stage: 'worker_bootstrap_restart' },
    });
    const stop = stopTaskRun({ run, terminate: true });
    await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
    expect((await new Observer().observe(run)).disposition).toBe('failed');
    expect(
      (await db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run.id) }))
        ?.status,
    ).toBe(RunStatus.Canceled);
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: RunStatus.Canceled }),
    );
    rpcRelease();
    await stop;
  });

  it('finalizes cancellation racing a persisted retry before any replacement dispatch', async () => {
    const run = await fixture();
    expect((await new Observer().observe(run)).disposition).toBe('restart');
    const stop = stopTaskRun({ run, terminate: true });
    await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
    await new Observer().recover();
    const persisted = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(persisted?.status).toBe(RunStatus.Canceled);
    expect(persisted?.machineId).toBeNull();
    expect(persisted?.canceledAt).toBeInstanceOf(Date);
    expect(
      (await db.query.tasks.findFirst({ where: eq(tasks.id, run.taskId) }))
        ?.state,
    ).toBe('canceled');
    rpcFail(new Error('Old sandbox was removed'));
    await expect(stop).rejects.toThrow('Old sandbox was removed');
  });

  it('watchdog cancels an abandoned pre-claim stop and makes its sandbox cleanup eligible', async () => {
    const run = await fixture();
    const stop = stopTaskRun({ run, terminate: true });
    await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
    // Execute the actual scan query but restrict side effects to owned fixtures.
    const findMany = db.query.taskRuns.findMany.bind(db.query.taskRuns);
    vi.spyOn(db.query.taskRuns, 'findMany').mockImplementation((config) => {
      if (typeof config?.where === 'function')
        throw new Error('Expected SQL scan predicate');
      return findMany({
        ...config,
        where: and(config?.where, inArray(taskRuns.taskId, ownedTasks)),
      });
    });
    expect(await new Observer().scan()).toBe(1);
    const persisted = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(persisted?.status).toBe(RunStatus.Canceled);
    expect(persisted?.canceledAt).toBeInstanceOf(Date);
    expect(persisted?.completedAt).toBeNull();
    expect(persisted?.machineId).toBe(run.machineId);
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: RunStatus.Canceled }),
    );
    expect(
      (
        await findFinishedRunsWithSandbox(new Date(Date.now() + 3 * 60_000))
      ).some((item) => item.id === run.id),
    ).toBe(true);
    rpcRelease();
    await stop;
  });

  it('still retries a genuine first bootstrap exit after a resumable soft stop', async () => {
    const run = await fixture();
    const stop = stopTaskRun({ run });
    await vi.waitFor(() => expect(rpcEntered).toHaveBeenCalled());
    expect(
      (await db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run.id) }))
        ?.cancelRequestedAt,
    ).toBeNull();
    expect((await new Observer().observe(run)).disposition).toBe('restart');
    const persisted = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(persisted?.status).toBe(RunStatus.Pending);
    expect(persisted?.machineId).toBeNull();
    expect(
      (await findPersistedWorkerBootstrapRestarts()).some(
        (item) => item.id === run.id,
      ),
    ).toBe(true);
    expect(finishRun).not.toHaveBeenCalled();
    rpcRelease();
    await stop;
  });

  it('still fails an unexpected replacement exit and persists the task projection', async () => {
    const run = await fixture();
    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: 'Fixture prior retry',
      details: { stage: 'worker_bootstrap_restart' },
    });
    expect((await new Observer().observe(run)).disposition).toBe('failed');
    const persisted = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });
    expect(persisted?.status).toBe(RunStatus.Failed);
    expect(persisted?.completedAt).toBeInstanceOf(Date);
    expect(
      (await db.query.tasks.findFirst({ where: eq(tasks.id, run.taskId) }))
        ?.state,
    ).toBe('failed');
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id, status: RunStatus.Failed }),
    );
  });
});

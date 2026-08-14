import { eq } from 'drizzle-orm';
import { RunStatus } from '@roomote/types';

import { db } from '../db';
import { runFactory } from '../fixtures/factories/run.factory';
import { taskFactory } from '../fixtures/factories/task.factory';
import { taskRuns, tasks } from '../schema';
import {
  claimTaskGoalContinuationForRun,
  markTaskGoalForRun,
} from './task-goals';
import {
  clearTaskWaitSchedule,
  findProtectedTaskWaitSnapshotHandles,
  findTaskWaitsNeedingWake,
  releaseTaskWaitResume,
  scheduleTaskWait,
} from './task-waits';

describe('task waits', () => {
  it('persists the wake deadline and rotates an active goal generation', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Check the deployment later',
      goalStatus: 'active',
      goalMaxContinuations: 4,
      goalContinuationsUsed: 1,
      goalLastContinuationId: 'goal-generation:current',
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      vendor: 'docker',
      machineId: 'docker-1',
    });
    const now = new Date('2026-08-13T15:00:00.000Z');

    await expect(
      scheduleTaskWait({
        runId: run.id,
        delayMs: 30 * 60 * 1_000,
        reason: 'Check the deployment',
        now,
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      waitUntil: new Date('2026-08-13T15:30:00.000Z'),
    });

    const storedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(storedTask?.goalStatus).toBe('active');
    expect(storedTask?.goalContinuationsUsed).toBe(1);
    expect(storedTask?.goalLastContinuationId).toMatch(/^goal-generation:/);
    expect(storedTask?.goalLastContinuationId).not.toBe(
      'goal-generation:current',
    );
    expect(storedTask?.goalGenerationIds).toEqual([
      storedTask?.goalLastContinuationId,
    ]);
    await expect(
      claimTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'goal-continuation:must-wait',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'not_active',
      goal: { continuationsUsed: 1 },
    });
    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: 'goal-generation:current',
        status: 'complete',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'generation_mismatch',
      goal: { status: 'active' },
    });
  });

  it('rejects duplicate waits without replacing the original deadline', async () => {
    const run = await runFactory.create({
      status: RunStatus.Running,
      vendor: 'docker',
      machineId: 'docker-2',
      waitUntil: new Date('2026-08-13T15:30:00.000Z'),
      waitReason: 'Original check',
    });

    await expect(
      scheduleTaskWait({
        runId: run.id,
        delayMs: 60 * 60 * 1_000,
        reason: 'Replacement check',
        now: new Date('2026-08-13T15:00:00.000Z'),
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'already_waiting',
      waitUntil: new Date('2026-08-13T15:30:00.000Z'),
      sleepRequired: true,
    });
  });

  it('does not treat a consumed wait as an idempotent pending wait', async () => {
    const run = await runFactory.create({
      status: RunStatus.Completed,
      vendor: 'docker',
      waitUntil: new Date('2026-08-13T15:30:00.000Z'),
      waitReason: 'Original check',
      waitResumedAt: new Date('2026-08-13T15:30:01.000Z'),
    });

    await expect(
      scheduleTaskWait({
        runId: run.id,
        delayMs: 60 * 60 * 1_000,
        reason: 'Retry check',
      }),
    ).resolves.toMatchObject({
      scheduled: false,
      reason: 'already_resumed',
    });
  });

  it('restores the prior goal generation when scheduling is rolled back', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Check the deployment later',
      goalStatus: 'active',
      goalLastContinuationId: 'goal-generation:current',
      goalGenerationIds: ['goal-generation:current'],
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      vendor: 'docker',
      machineId: 'docker-rollback',
    });

    const result = await scheduleTaskWait({
      runId: run.id,
      delayMs: 30 * 60 * 1_000,
      reason: 'Check the deployment',
    });
    expect(result.scheduled).toBe(true);
    if (!result.scheduled) throw new Error('Expected wait to be scheduled');

    await clearTaskWaitSchedule({
      runId: run.id,
      waitUntil: result.waitUntil,
      goalRollback: result.goalRollback,
    });

    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({
      goalLastContinuationId: 'goal-generation:current',
      goalGenerationIds: ['goal-generation:current'],
    });
  });

  it('only reopens a wait claim after its resume child is canceled', async () => {
    const waitUntil = new Date('2026-08-13T15:30:00.000Z');
    const sourceRun = await runFactory.create({
      status: RunStatus.Completed,
      vendor: 'docker',
      snapshotId: 'standby-claim',
      snapshotCreatedAt: new Date(),
      waitUntil,
      waitReason: 'Check deployment',
    });
    const resumeRun = await runFactory.create({
      taskId: sourceRun.taskId,
      sourceRunId: sourceRun.id,
      status: RunStatus.Pending,
      vendor: 'docker',
    });
    await db
      .update(taskRuns)
      .set({ waitResumedAt: new Date(), waitResumeRunId: resumeRun.id })
      .where(eq(taskRuns.id, sourceRun.id));

    await expect(
      releaseTaskWaitResume({
        runId: sourceRun.id,
        waitUntil,
        resumeRunId: resumeRun.id,
      }),
    ).resolves.toBe(false);
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Canceled, canceledAt: new Date() })
      .where(eq(taskRuns.id, resumeRun.id));
    await expect(
      releaseTaskWaitResume({
        runId: sourceRun.id,
        waitUntil,
        resumeRunId: resumeRun.id,
      }),
    ).resolves.toBe(true);
    await expect(
      db.query.taskRuns.findFirst({ where: eq(taskRuns.id, sourceRun.id) }),
    ).resolves.toMatchObject({
      waitResumedAt: null,
      waitResumeRunId: null,
    });
  });

  it('recovers a due wait when its claimed child is canceled later', async () => {
    const waitUntil = new Date('2026-08-13T15:30:00.000Z');
    const sourceRun = await runFactory.create({
      status: RunStatus.Completed,
      vendor: 'docker',
      snapshotId: 'standby-late-cancel',
      snapshotCreatedAt: new Date(),
      waitUntil,
      waitReason: 'Check deployment',
    });
    const resumeRun = await runFactory.create({
      taskId: sourceRun.taskId,
      sourceRunId: sourceRun.id,
      status: RunStatus.Pending,
      vendor: 'docker',
    });
    await db
      .update(taskRuns)
      .set({ waitResumedAt: new Date(), waitResumeRunId: resumeRun.id })
      .where(eq(taskRuns.id, sourceRun.id));

    const recoveryInput = {
      now: new Date('2026-08-13T16:00:00.000Z'),
      limit: 500,
    };
    await expect(findTaskWaitsNeedingWake(recoveryInput)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sourceRun.id })]),
    );

    await db
      .update(taskRuns)
      .set({ status: RunStatus.Canceled, canceledAt: new Date() })
      .where(eq(taskRuns.id, resumeRun.id));

    await expect(findTaskWaitsNeedingWake(recoveryInput)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceRun.id, waitUntil }),
      ]),
    );
    await expect(
      findProtectedTaskWaitSnapshotHandles({ provider: 'docker' }),
    ).resolves.toContain('standby-late-cancel');
  });

  it('rejects unsupported providers and short waits', async () => {
    const run = await runFactory.create({
      status: RunStatus.Running,
      vendor: null,
      machineId: 'missing-provider',
    });

    await expect(
      scheduleTaskWait({
        runId: run.id,
        delayMs: 30 * 60 * 1_000,
        reason: 'Check later',
      }),
    ).resolves.toMatchObject({ scheduled: false, reason: 'unsupported' });
    await expect(
      scheduleTaskWait({
        runId: run.id,
        delayMs: 60_000,
        reason: 'Check soon',
      }),
    ).resolves.toEqual({
      scheduled: false,
      reason: 'invalid_duration',
      waitUntil: null,
    });
  });
});

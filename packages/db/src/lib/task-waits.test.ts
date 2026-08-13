import { eq } from 'drizzle-orm';
import { RunStatus } from '@roomote/types';

import { db } from '../db';
import { runFactory } from '../fixtures/factories/run.factory';
import { taskFactory } from '../fixtures/factories/task.factory';
import { tasks } from '../schema';
import { markTaskGoalForRun } from './task-goals';
import { scheduleTaskWait } from './task-waits';

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
    ).resolves.toEqual({
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
    });
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

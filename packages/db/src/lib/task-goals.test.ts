import { runFactory } from '../fixtures/factories/run.factory';
import { taskFactory } from '../fixtures/factories/task.factory';
import {
  claimTaskGoalContinuationForRun,
  getTaskGoalForRun,
  markTaskGoalForRun,
  releaseTaskGoalContinuationForRun,
} from './task-goals';

describe('task goals', () => {
  it('claims bounded continuations and marks the goal budget limited', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Finish the long-running task',
      goalStatus: 'active',
      goalMaxContinuations: 2,
    });
    const run = await runFactory.create({ taskId: task.id });

    expect(await getTaskGoalForRun(run.id)).toMatchObject({
      objective: 'Finish the long-running task',
      status: 'active',
      continuationsUsed: 0,
      maxContinuations: 2,
    });

    const first = await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'turn-1',
    });
    const duplicate = await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'turn-1',
    });
    const second = await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'turn-2',
    });
    const exhausted = await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'turn-3',
    });

    expect(first).toMatchObject({
      updated: true,
      goal: { continuationsUsed: 1 },
    });
    expect(second).toMatchObject({
      updated: true,
      goal: { continuationsUsed: 2 },
    });
    expect(duplicate).toMatchObject({
      updated: false,
      reason: 'already_claimed',
      goal: { continuationsUsed: 1 },
    });
    expect(exhausted).toMatchObject({
      updated: false,
      reason: 'budget_exhausted',
      goal: { status: 'budget_limited', continuationsUsed: 2 },
    });
  });

  it('releases a continuation claim only for the matching delivery', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Retry failed continuation delivery',
      goalStatus: 'active',
      goalMaxContinuations: 2,
    });
    const run = await runFactory.create({ taskId: task.id });

    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'delivery-1',
    });

    await expect(
      releaseTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'other-delivery',
      }),
    ).resolves.toBe(false);
    await expect(
      releaseTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'delivery-1',
      }),
    ).resolves.toBe(true);
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      status: 'active',
      continuationsUsed: 0,
    });
  });

  it('reopens a budget-limited goal when final continuation delivery fails', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Recover the final continuation budget',
      goalStatus: 'active',
      goalMaxContinuations: 1,
    });
    const run = await runFactory.create({ taskId: task.id });

    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'final-delivery',
    });
    await expect(
      claimTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'racing-completion',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'budget_exhausted',
      goal: { status: 'budget_limited' },
    });

    await expect(
      releaseTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'final-delivery',
      }),
    ).resolves.toBe(true);
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      status: 'active',
      continuationsUsed: 0,
    });
  });

  it('claims a completion id only once across concurrent and later retries', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Avoid duplicate continuation delivery',
      goalStatus: 'active',
      goalMaxContinuations: 3,
    });
    const run = await runFactory.create({ taskId: task.id });

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        claimTaskGoalContinuationForRun({
          runId: run.id,
          continuationId: 'completion-1',
        }),
      ),
    );
    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'completion-2',
    });
    const replay = await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'completion-1',
    });

    expect(concurrent.filter((result) => result.updated)).toHaveLength(1);
    expect(replay).toMatchObject({
      updated: false,
      reason: 'already_claimed',
      goal: { continuationsUsed: 2 },
    });
  });

  it('requires the same blocker on three consecutive goal turns', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Require durable blocker evidence',
      goalStatus: 'active',
      goalMaxContinuations: 5,
    });
    const run = await runFactory.create({ taskId: task.id });

    const observe = (reason: string) =>
      markTaskGoalForRun({ runId: run.id, status: 'blocked', reason });
    const continueTurn = (continuationId: string) =>
      claimTaskGoalContinuationForRun({ runId: run.id, continuationId });

    await expect(observe('Missing credential')).resolves.toMatchObject({
      updated: false,
      reason: 'blocker_pending',
    });
    await expect(observe('Missing credential')).resolves.toMatchObject({
      updated: false,
      reason: 'blocker_pending',
    });
    await continueTurn('blocker-turn-1');
    await observe('Different blocker');
    await continueTurn('blocker-turn-2');
    await observe('Missing credential');
    await continueTurn('blocker-turn-3');
    await expect(observe('Missing credential')).resolves.toMatchObject({
      updated: false,
      reason: 'blocker_pending',
    });
    await continueTurn('blocker-turn-4');
    await expect(observe('Missing credential')).resolves.toMatchObject({
      updated: true,
      goal: { status: 'blocked', blockedReason: 'Missing credential' },
    });
  });

  it('resets a blocker streak when a turn does not report it', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Reset interrupted blocker evidence',
      goalStatus: 'active',
      goalMaxContinuations: 4,
    });
    const run = await runFactory.create({ taskId: task.id });

    await markTaskGoalForRun({
      runId: run.id,
      status: 'blocked',
      reason: 'Missing credential',
    });
    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'reported-turn',
    });
    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'unreported-turn',
    });
    const restarted = await markTaskGoalForRun({
      runId: run.id,
      status: 'blocked',
      reason: 'Missing credential',
    });

    expect(restarted).toMatchObject({
      updated: false,
      reason: 'blocker_pending',
    });
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('keeps terminal goal transitions idempotent', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Complete the objective',
      goalStatus: 'active',
      goalMaxContinuations: 5,
    });
    const run = await runFactory.create({ taskId: task.id });

    const completed = await markTaskGoalForRun({
      runId: run.id,
      status: 'complete',
    });
    const duplicate = await markTaskGoalForRun({
      runId: run.id,
      status: 'complete',
    });

    expect(completed).toMatchObject({
      updated: true,
      goal: { status: 'complete' },
    });
    expect(duplicate).toMatchObject({
      updated: false,
      reason: 'not_active',
      goal: { status: 'complete' },
    });
  });
});

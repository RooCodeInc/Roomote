import { eq } from 'drizzle-orm';

import { db } from '../db';
import { runFactory } from '../fixtures/factories/run.factory';
import { taskFactory } from '../fixtures/factories/task.factory';
import { tasks } from '../schema';
import {
  claimTaskGoalContinuationForRun,
  getTaskGoalForRun,
  markTaskGoalForRun,
  prepareTaskGoalActivation,
  releaseTaskGoalContinuationForRun,
  type TaskGoalMutationResult,
} from './task-goals';

describe('task goals', () => {
  it('holds a fast completion until goal delivery is committed', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Old objective',
      goalStatus: 'blocked',
      goalMaxContinuations: 2,
      goalContinuationsUsed: 2,
      goalBlockedReason: 'Old blocker',
      goalContinuationIds: ['old-turn'],
    });
    const run = await runFactory.create({ taskId: task.id });

    const activation = await prepareTaskGoalActivation({
      taskId: task.id,
      goal: {
        objective: 'Finish the new objective',
        maxContinuations: 4,
      },
    });

    expect(activation).not.toBeNull();
    await expect(
      prepareTaskGoalActivation({
        taskId: task.id,
        goal: {
          objective: 'Concurrent objective',
          maxContinuations: 4,
        },
      }),
    ).resolves.toBeNull();
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      objective: 'Finish the new objective',
      status: 'active',
    });
    let claimSettled = false;
    const claim = claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'pending-turn',
    }).finally(() => {
      claimSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claimSettled).toBe(false);
    await expect(activation!.commit()).resolves.toMatchObject({
      objective: 'Finish the new objective',
      status: 'active',
      maxContinuations: 4,
      continuationsUsed: 0,
      blockedReason: null,
    });
    await expect(claim).resolves.toMatchObject({
      updated: true,
      goal: { continuationsUsed: 1 },
    });
  });

  it('restores the previous goal when delivery fails', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Keep the existing objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
      goalContinuationsUsed: 1,
      goalContinuationIds: ['existing-turn'],
    });
    const run = await runFactory.create({ taskId: task.id });
    const activation = await prepareTaskGoalActivation({
      taskId: task.id,
      goal: {
        objective: 'Replacement objective',
        maxContinuations: 5,
      },
    });

    await expect(activation!.rollback()).resolves.toBe(true);
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      objective: 'Keep the existing objective',
      status: 'active',
      maxContinuations: 3,
      continuationsUsed: 1,
    });
  });

  it('stops a waiting completion when first-time goal delivery fails', async () => {
    const task = await taskFactory.create();
    const run = await runFactory.create({ taskId: task.id });
    const activation = await prepareTaskGoalActivation({
      taskId: task.id,
      goal: {
        objective: 'Objective that cannot be delivered',
        maxContinuations: 5,
      },
    });
    const claim = claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'failed-delivery-turn',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await activation!.rollback();

    await expect(claim).resolves.toMatchObject({
      updated: false,
      reason: 'not_active',
      goal: null,
    });
  });

  it('rejects a stale continuation claim that crosses a goal replacement', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Original objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
    });
    const run = await runFactory.create({ taskId: task.id });

    let claim: Promise<TaskGoalMutationResult> | undefined;
    await db.transaction(async (tx) => {
      // Hold the task row so the in-flight claim reads the original goal but
      // cannot run its conditional update until the replacement is written.
      await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1)
        .for('update');

      claim = claimTaskGoalContinuationForRun({
        runId: run.id,
        continuationId: 'stale-turn',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mirrors the row a prepared and committed replacement goal leaves
      // behind: active, unused budget, and a fresh activation generation.
      await tx
        .update(tasks)
        .set({
          goalObjective: 'Replacement objective',
          goalStatus: 'active',
          goalMaxContinuations: 3,
          goalContinuationsUsed: 0,
          goalContinuationIds: [],
          goalLastContinuationId: 'goal-generation:replacement',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
    });

    await expect(claim!).resolves.toMatchObject({
      updated: false,
      reason: 'not_active',
    });
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      objective: 'Replacement objective',
      status: 'active',
      continuationsUsed: 0,
    });
  });

  it('rejects terminal mutations while goal activation is pending', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Original objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
    });
    const run = await runFactory.create({ taskId: task.id });
    const activation = await prepareTaskGoalActivation({
      taskId: task.id,
      goal: {
        objective: 'Replacement objective',
        maxContinuations: 5,
      },
    });

    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: null,
        status: 'complete',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'activation_pending',
    });
    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: null,
        status: 'blocked',
        reason: 'Stale blocker',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'activation_pending',
    });
    await expect(activation!.commit()).resolves.toMatchObject({
      objective: 'Replacement objective',
      status: 'active',
    });
  });

  it('rejects a stale completion that crosses a goal replacement', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Original objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
      goalLastContinuationId: 'goal-generation:original',
    });
    const run = await runFactory.create({ taskId: task.id });

    let completion: Promise<TaskGoalMutationResult> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1)
        .for('update');

      completion = markTaskGoalForRun({
        runId: run.id,
        generation: 'goal-generation:original',
        status: 'complete',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await tx
        .update(tasks)
        .set({
          goalObjective: 'Replacement objective',
          goalStatus: 'active',
          goalMaxContinuations: 5,
          goalContinuationsUsed: 0,
          goalLastContinuationId: 'goal-activation:replacement',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
    });

    await expect(completion!).resolves.toMatchObject({
      updated: false,
      reason: 'not_active',
    });
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      objective: 'Replacement objective',
      status: 'active',
    });
  });

  it('rejects outgoing terminal mutations after replacement activation commits', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Original objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
      goalLastContinuationId: 'goal-generation:original',
    });
    const run = await runFactory.create({ taskId: task.id });
    const activation = await prepareTaskGoalActivation({
      taskId: task.id,
      goal: {
        objective: 'Replacement objective',
        maxContinuations: 5,
      },
    });
    await activation!.commit();

    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: 'goal-generation:original',
        status: 'complete',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'generation_mismatch',
    });
    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: 'goal-generation:original',
        status: 'blocked',
        reason: 'Stale blocker',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'generation_mismatch',
    });
    await expect(getTaskGoalForRun(run.id)).resolves.toMatchObject({
      objective: 'Replacement objective',
      generation: activation!.generation,
      status: 'active',
    });
  });

  it('accepts an assigned same-goal generation after a continuation advances', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Finish the current objective',
      goalStatus: 'active',
      goalMaxContinuations: 3,
      goalLastContinuationId: 'goal-generation:initial',
      goalContinuationIds: ['goal-generation:initial'],
    });
    const run = await runFactory.create({ taskId: task.id });

    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'continuation-turn',
    });

    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: 'goal-generation:initial',
        status: 'complete',
      }),
    ).resolves.toMatchObject({
      updated: true,
      goal: { status: 'complete' },
    });
  });

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

  it('keeps a released generation assigned after another continuation advances', async () => {
    const task = await taskFactory.create({
      goalObjective: 'Retry and finish the goal',
      goalStatus: 'active',
      goalMaxContinuations: 3,
      goalLastContinuationId: 'goal-generation:initial',
      goalContinuationIds: ['goal-generation:initial'],
    });
    const run = await runFactory.create({ taskId: task.id });

    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'failed-delivery',
    });
    await releaseTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'failed-delivery',
    });
    const releasedGoal = await getTaskGoalForRun(run.id);
    await claimTaskGoalContinuationForRun({
      runId: run.id,
      continuationId: 'next-continuation',
    });

    await expect(
      markTaskGoalForRun({
        runId: run.id,
        generation: releasedGoal!.generation,
        status: 'complete',
      }),
    ).resolves.toMatchObject({ updated: true });
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

    const observe = async (reason: string) => {
      const goal = await getTaskGoalForRun(run.id);
      return markTaskGoalForRun({
        runId: run.id,
        generation: goal!.generation,
        status: 'blocked',
        reason,
      });
    };
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
      generation: null,
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
      generation: 'unreported-turn',
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
      generation: null,
      status: 'complete',
    });
    const duplicate = await markTaskGoalForRun({
      runId: run.id,
      generation: null,
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

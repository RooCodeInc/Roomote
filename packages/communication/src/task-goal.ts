import { prepareTaskGoalActivation } from '@roomote/db/server';
import {
  DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
  taskGoalInputSchema,
  type TaskGoal,
} from '@roomote/types';
import type { TaskGoalActivationError } from './task-goal-command';

export async function activateTaskGoal(input: {
  taskId: string;
  objective: string;
  maxContinuations?: number;
  deliver: (goal: TaskGoal) => Promise<boolean | void>;
}): Promise<
  | { success: true; goal: TaskGoal }
  | { success: false; error: TaskGoalActivationError }
> {
  const parsed = taskGoalInputSchema.safeParse({
    objective: input.objective,
    maxContinuations:
      input.maxContinuations ?? DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
  });
  if (!parsed.success) {
    return { success: false, error: 'invalid_goal' };
  }

  const activation = await prepareTaskGoalActivation({
    taskId: input.taskId,
    goal: parsed.data,
  });
  if (!activation) {
    return { success: false, error: 'activation_pending' };
  }

  const pendingGoal: TaskGoal = {
    ...parsed.data,
    generation: activation.generation,
    status: 'active',
    continuationsUsed: 0,
    blockedReason: null,
    completedAt: null,
  };

  try {
    const delivered = await input.deliver(pendingGoal);
    if (delivered === false) {
      await activation.rollback();
      return { success: false, error: 'delivery_rejected' };
    }
  } catch (error) {
    await activation.rollback().catch(() => false);
    throw error;
  }

  const goal = await activation.commit();
  if (!goal) {
    await activation.rollback();
    return { success: false, error: 'activation_pending' };
  }

  return { success: true, goal };
}

import { prepareTaskGoalActivation } from '@roomote/db/server';
import {
  DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
  type TaskGoal,
} from '@roomote/types';

import { sendMessageToTask } from './sendMessageToTask.js';

export async function startTaskGoal(input: {
  taskId: string;
  userId: string;
  objective: string;
  source: string;
  clientMessageId: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const goal = {
    objective: input.objective,
    maxContinuations: DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
  };
  const activation = await prepareTaskGoalActivation({
    taskId: input.taskId,
    goal,
  });
  if (!activation) {
    return {
      success: false,
      error: 'Goal Mode activation is already pending.',
    };
  }

  const goalContext: TaskGoal = {
    ...goal,
    generation: activation.generation,
    status: 'active',
    continuationsUsed: 0,
    blockedReason: null,
    completedAt: null,
  };

  try {
    const delivered = await sendMessageToTask({
      taskId: input.taskId,
      userId: input.userId,
      message: input.objective,
      source: input.source,
      clientMessageId: input.clientMessageId,
      goalContext,
    });
    if (!delivered.success) {
      await activation.rollback();
      return { success: false, error: delivered.error };
    }
  } catch (error) {
    await activation.rollback().catch(() => undefined);
    throw error;
  }

  let committed: TaskGoal | null;
  try {
    committed = await activation.commit();
  } catch (error) {
    await activation.rollback().catch(() => undefined);
    throw error;
  }
  if (!committed) {
    await activation.rollback();
    return { success: false, error: 'Goal Mode activation was superseded.' };
  }

  return { success: true };
}

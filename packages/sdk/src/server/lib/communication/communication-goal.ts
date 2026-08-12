import { prepareTaskGoalActivation } from '@roomote/db/server';
import type { TaskGoal, TaskGoalInput } from '@roomote/types';

export type ActivateCommunicationGoalResult =
  | { success: true; goal: TaskGoal }
  | {
      success: false;
      reason: 'activation_pending' | 'activation_superseded';
    };

export async function activateCommunicationGoal(input: {
  taskId: string;
  goal: TaskGoalInput;
  deliver: (goalContext: TaskGoal) => Promise<void>;
}): Promise<ActivateCommunicationGoalResult> {
  const activation = await prepareTaskGoalActivation({
    taskId: input.taskId,
    goal: input.goal,
  });
  if (!activation) {
    return { success: false, reason: 'activation_pending' };
  }

  const goalContext: TaskGoal = {
    ...input.goal,
    generation: activation.generation,
    status: 'active',
    continuationsUsed: 0,
    blockedReason: null,
    completedAt: null,
  };

  try {
    await input.deliver(goalContext);
  } catch (error) {
    await activation.rollback().catch(() => false);
    throw error;
  }

  const goal = await activation.commit();
  if (!goal) {
    await activation.rollback();
    return { success: false, reason: 'activation_superseded' };
  }

  return { success: true, goal };
}

import type { QueuedCommunicationMessage, TaskGoal } from '@roomote/types';

export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_COMMAND = `/${GOAL_COMMAND_NAME}`;

export type GoalCommand = { objective: string };
export type TaskGoalActivationError =
  | 'invalid_goal'
  | 'activation_pending'
  | 'delivery_rejected';

const goalCommandPattern = new RegExp(
  `^\\/${GOAL_COMMAND_NAME}(?:\\s+([\\s\\S]*))?$`,
  'iu',
);

export function parseGoalCommand(text: string): GoalCommand | null {
  const match = goalCommandPattern.exec(text.trim());
  return match ? { objective: (match[1] ?? '').trim() } : null;
}

export function withTaskGoalContext(
  message: QueuedCommunicationMessage,
  goal: TaskGoal,
): QueuedCommunicationMessage {
  return {
    ...message,
    text: goal.objective,
    images: undefined,
    formattedPrompt: goal.objective,
    goalContext: goal,
  };
}

export function getTaskGoalActivationMessage(
  result:
    | { success: true }
    | { success: false; error: TaskGoalActivationError },
): string {
  if (result.success) {
    return 'Goal Mode enabled.';
  }
  if (result.error === 'invalid_goal') {
    return `Add an objective after \`${GOAL_COMMAND}\`.`;
  }
  if (result.error === 'delivery_rejected') {
    return 'Goal Mode could not deliver the objective. Try again.';
  }
  return 'Goal Mode activation is already in progress. Try again shortly.';
}

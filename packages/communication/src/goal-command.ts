import {
  DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
  type TaskGoalInput,
} from '@roomote/types';

export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_COMMAND_USAGE = '/goal <objective>';

export type ParsedGoalCommand = {
  objective: string;
  goal: TaskGoalInput | null;
};

export function parseGoalCommand(text: string): ParsedGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }

  const objective = (match[1] ?? '').trim();
  return {
    objective,
    goal: objective
      ? {
          objective,
          maxContinuations: DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
        }
      : null,
  };
}

import type { AcpUiMessage } from './types';

interface GoalPromptProvenance {
  objective: string;
  generation: string | null;
}

export function getGoalPromptProvenance(
  message: AcpUiMessage,
): GoalPromptProvenance | null {
  const data = message.data as Record<string, unknown>;
  if (message.role !== 'user' || !data.goal) {
    return null;
  }

  const goal = data.goal;
  if (!goal || typeof goal !== 'object') {
    return null;
  }

  const objective = Reflect.get(goal, 'objective');
  const generation = Reflect.get(goal, 'generation');

  if (
    typeof objective !== 'string' ||
    objective.trim().length === 0 ||
    (generation !== null && typeof generation !== 'string')
  ) {
    return null;
  }

  return { objective, generation };
}

export function findLatestGoalPrompt(
  messages: AcpUiMessage[],
): GoalPromptProvenance | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const goal = getGoalPromptProvenance(messages[index]!);
    if (goal) {
      return goal;
    }
  }

  return null;
}

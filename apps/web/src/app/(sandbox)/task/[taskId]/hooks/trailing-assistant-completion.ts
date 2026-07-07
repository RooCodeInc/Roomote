import { CloudTaskStatus, type TaskPhase } from '@roomote/types';

const TURN_COMPLETION_TASK_PHASES = new Set<TaskPhase>([
  'idle',
  'waiting_for_prompt',
  'waiting_for_user_input',
]);

export function shouldMarkTrailingAssistantCompletion({
  taskPhase,
  taskStatus,
}: {
  taskPhase?: TaskPhase | null;
  taskStatus?: CloudTaskStatus | null;
}): boolean {
  if (
    taskStatus === CloudTaskStatus.Failed ||
    taskStatus === CloudTaskStatus.Canceled
  ) {
    return false;
  }

  if (taskPhase) {
    return TURN_COMPLETION_TASK_PHASES.has(taskPhase);
  }

  return (
    taskStatus === CloudTaskStatus.Completed ||
    taskStatus === CloudTaskStatus.Idle
  );
}

import type { Task } from '@/lib/server';

export const TASK_BOARD_COLUMNS = [
  'active',
  'needs-input',
  'blocked',
  'done',
] as const;

export type TaskBoardColumn = (typeof TASK_BOARD_COLUMNS)[number];

type BoardTask = Pick<
  Task,
  'state' | 'goalStatus' | 'workflow' | 'initiatorKind' | 'repositoryName'
> & {
  taskRun: Pick<Task['taskRun'], 'taskPhase' | 'prRepo' | 'payload'>;
};

export function getTaskBoardColumn(task: BoardTask): TaskBoardColumn {
  if (
    task.state === 'active' &&
    task.taskRun.taskPhase === 'waiting_for_user_input'
  ) {
    return 'needs-input';
  }

  if (
    task.state === 'failed' ||
    task.goalStatus === 'blocked' ||
    task.goalStatus === 'budget_limited'
  ) {
    return 'blocked';
  }

  if (
    task.state === 'completed' ||
    task.state === 'canceled' ||
    task.goalStatus === 'complete'
  ) {
    return 'done';
  }

  return 'active';
}

export function getTaskWorkType(task: BoardTask): string {
  if (task.workflow === 'pr_review') {
    return 'Review';
  }

  if (
    task.workflow === 'pr_conflict_resolve' ||
    task.taskRun.prRepo ||
    task.taskRun.payload.repo ||
    task.repositoryName
  ) {
    return 'Code';
  }

  if (
    task.initiatorKind === 'automation' ||
    task.workflow === 'scan' ||
    task.workflow === 'mcp_recommendations'
  ) {
    return 'Automation';
  }

  return 'Conversation';
}

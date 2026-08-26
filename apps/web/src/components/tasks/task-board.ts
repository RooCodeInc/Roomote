import { isBootingRunStatus, RunStatus } from '@roomote/types';

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
  | 'state'
  | 'requestedWorkKind'
  | 'resolutionStatus'
  | 'goalStatus'
  | 'workflow'
  | 'initiatorKind'
  | 'repositoryName'
> & {
  taskRun: Pick<Task['taskRun'], 'status' | 'taskPhase' | 'prRepo' | 'payload'>;
};

export function getTaskBoardColumn(task: BoardTask): TaskBoardColumn {
  if (
    isBootingRunStatus(task.taskRun.status) ||
    task.taskRun.taskPhase === 'running' ||
    task.taskRun.taskPhase === 'waiting_for_sandbox_provider' ||
    (task.taskRun.status === RunStatus.Running &&
      task.taskRun.taskPhase !== 'waiting_for_user_input' &&
      task.taskRun.taskPhase !== 'waiting_for_prompt')
  ) {
    return 'active';
  }

  if (task.taskRun.taskPhase === 'waiting_for_user_input') {
    return 'needs-input';
  }

  if (
    task.state === 'failed' ||
    task.goalStatus === 'blocked' ||
    task.goalStatus === 'budget_limited' ||
    task.resolutionStatus === 'needs_follow_up'
  ) {
    return 'blocked';
  }

  if (task.resolutionStatus === 'awaiting_confirmation') {
    return 'needs-input';
  }

  if (task.resolutionStatus === 'acknowledged') {
    return 'done';
  }

  if (
    task.state === 'completed' ||
    task.state === 'canceled' ||
    task.goalStatus === 'complete'
  ) {
    return 'done';
  }

  const isDeliverable =
    task.requestedWorkKind === 'plan' ||
    task.requestedWorkKind === 'implement' ||
    Boolean(task.taskRun.prRepo);

  if (task.taskRun.taskPhase === 'waiting_for_prompt' && !isDeliverable) {
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

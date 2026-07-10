import { type TaskWorkflow } from '@roomote/types';

import {
  DEFAULT_VISIBLE_TASK_WORKFLOWS,
  isTaskWorkflow,
} from '@/lib/task-categories';

const DEFAULT_TASK_TYPE_FILTER_SET = new Set<TaskWorkflow>(
  DEFAULT_VISIBLE_TASK_WORKFLOWS,
);

export function parseTaskTypeFilterParam(value: string): TaskWorkflow[] | null {
  if (value === '') {
    return [];
  }

  const workflows = [...new Set(value.split(',').filter(isTaskWorkflow))];

  return workflows.length > 0 ? workflows : null;
}

export function isDefaultTaskTypeFilterSelection(
  workflows: readonly TaskWorkflow[],
): boolean {
  if (workflows.length !== DEFAULT_VISIBLE_TASK_WORKFLOWS.length) {
    return false;
  }

  return workflows.every((workflow) =>
    DEFAULT_TASK_TYPE_FILTER_SET.has(workflow),
  );
}

export function serializeTaskTypeFilterParam(
  workflows: readonly TaskWorkflow[],
): string | null {
  if (isDefaultTaskTypeFilterSelection(workflows)) {
    return null;
  }

  return workflows.join(',');
}

export function getTaskTypeFilterButtonLabel(
  workflows: readonly TaskWorkflow[],
): string {
  if (isDefaultTaskTypeFilterSelection(workflows)) {
    return 'Task Type';
  }

  if (workflows.length === 0) {
    return 'No Types';
  }

  if (workflows.length === 1) {
    return workflows[0] ?? 'Task Type';
  }

  return `${workflows.length} Types`;
}

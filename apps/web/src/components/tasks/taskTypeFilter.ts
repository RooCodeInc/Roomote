import {
  type CloudTaskType,
  DEFAULT_VISIBLE_CLOUD_TASK_TYPES,
  isCloudTaskType,
} from '@roomote/types';

const DEFAULT_TASK_TYPE_FILTER_SET = new Set(DEFAULT_VISIBLE_CLOUD_TASK_TYPES);

export function parseTaskTypeFilterParam(
  value: string,
): CloudTaskType[] | null {
  if (value === '') {
    return [];
  }

  const taskTypes = [...new Set(value.split(',').filter(isCloudTaskType))];

  return taskTypes.length > 0 ? taskTypes : null;
}

export function isDefaultTaskTypeFilterSelection(
  taskTypes: readonly CloudTaskType[],
): boolean {
  if (taskTypes.length !== DEFAULT_VISIBLE_CLOUD_TASK_TYPES.length) {
    return false;
  }

  return taskTypes.every((taskType) =>
    DEFAULT_TASK_TYPE_FILTER_SET.has(taskType),
  );
}

export function serializeTaskTypeFilterParam(
  taskTypes: readonly CloudTaskType[],
): string | null {
  if (isDefaultTaskTypeFilterSelection(taskTypes)) {
    return null;
  }

  return taskTypes.join(',');
}

export function getTaskTypeFilterButtonLabel(
  taskTypes: readonly CloudTaskType[],
): string {
  if (isDefaultTaskTypeFilterSelection(taskTypes)) {
    return 'Task Type';
  }

  if (taskTypes.length === 0) {
    return 'No Types';
  }

  if (taskTypes.length === 1) {
    return taskTypes[0] ?? 'Task Type';
  }

  return `${taskTypes.length} Types`;
}

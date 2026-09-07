import {
  TaskRobotIcon,
  useTaskRobotIconContext,
} from '@/components/tasks/TaskRobotIcon';

import type { TaskToolReference } from './task-tool-reference';

export function useTaskToolIcon(reference: TaskToolReference, failed: boolean) {
  const context = useTaskRobotIconContext();
  const taskId = reference?.taskId;
  const onOpenTask = context?.onOpenTask;
  return {
    iconElement:
      !failed && reference ? <TaskRobotIcon taskId={taskId} /> : undefined,
    iconAction:
      !failed && taskId && onOpenTask
        ? { label: 'Focus task prompt', onClick: () => onOpenTask(taskId) }
        : undefined,
  };
}

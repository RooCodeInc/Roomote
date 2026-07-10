import { RunStatus, HARNESS_LABELS, isCodingHarness } from '@roomote/types';

function getPhaseLabel(taskPhase: string | null): string | null {
  switch (taskPhase) {
    case 'idle':
      return 'Idle';
    case 'waiting_for_prompt':
      return 'Ready';
    case 'waiting_for_user_input':
      return 'Needs input';
    case 'running':
      return 'Working';
    case 'stopped':
      return 'Stopped';
    case 'shutting_down':
      return 'Terminating';
    default:
      return null;
  }
}

function getTaskRunStatusLabel(status: string): string {
  switch (status) {
    case RunStatus.Pending:
      return 'Pending';
    case RunStatus.Dequeued:
      return 'Dequeued';
    case RunStatus.Processing:
      return 'Processing';
    case RunStatus.Preparing:
      return 'Preparing';
    case RunStatus.Spawning:
      return 'Spawning';
    case RunStatus.Connecting:
      return 'Connecting';
    case RunStatus.Running:
      return 'Running';
    case RunStatus.Idle:
      return 'Idle';
    case RunStatus.Completed:
      return 'Completed';
    case RunStatus.Failed:
      return 'Failed';
    case RunStatus.Canceled:
      return 'Canceled';
    default:
      return status;
  }
}

export function getTaskStatusLabel(input: {
  completed: boolean;
  taskRunStatus: string | null;
  taskPhase: string | null;
}): string {
  const { completed, taskRunStatus, taskPhase } = input;

  if (!taskRunStatus) {
    return completed ? 'Completed' : 'Active';
  }

  if (taskRunStatus === RunStatus.Running) {
    return getPhaseLabel(taskPhase) ?? 'Running';
  }

  if (taskRunStatus === RunStatus.Idle) {
    return getPhaseLabel(taskPhase) ?? 'Idle';
  }

  return getTaskRunStatusLabel(taskRunStatus);
}

export function getHarnessLabel(harness: string | null): string | null {
  if (!harness) {
    return null;
  }

  return isCodingHarness(harness) ? HARNESS_LABELS[harness] : harness;
}

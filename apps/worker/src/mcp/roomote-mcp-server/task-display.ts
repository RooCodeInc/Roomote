import {
  CloudTaskStatus,
  HARNESS_LABELS,
  isCodingHarness,
} from '@roomote/types';

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

function getCloudJobStatusLabel(status: string): string {
  switch (status) {
    case CloudTaskStatus.Pending:
      return 'Pending';
    case CloudTaskStatus.Dequeued:
      return 'Dequeued';
    case CloudTaskStatus.Processing:
      return 'Processing';
    case CloudTaskStatus.Preparing:
      return 'Preparing';
    case CloudTaskStatus.Spawning:
      return 'Spawning';
    case CloudTaskStatus.Connecting:
      return 'Connecting';
    case CloudTaskStatus.Running:
      return 'Running';
    case CloudTaskStatus.Idle:
      return 'Idle';
    case CloudTaskStatus.Completed:
      return 'Completed';
    case CloudTaskStatus.Failed:
      return 'Failed';
    case CloudTaskStatus.Canceled:
      return 'Canceled';
    default:
      return status;
  }
}

export function getTaskStatusLabel(input: {
  completed: boolean;
  cloudJobStatus: string | null;
  taskPhase: string | null;
}): string {
  const { completed, cloudJobStatus, taskPhase } = input;

  if (!cloudJobStatus) {
    return completed ? 'Completed' : 'Active';
  }

  if (cloudJobStatus === CloudTaskStatus.Running) {
    return getPhaseLabel(taskPhase) ?? 'Running';
  }

  if (cloudJobStatus === CloudTaskStatus.Idle) {
    return getPhaseLabel(taskPhase) ?? 'Idle';
  }

  return getCloudJobStatusLabel(cloudJobStatus);
}

export function getHarnessLabel(harness: string | null): string | null {
  if (!harness) {
    return null;
  }

  return isCodingHarness(harness) ? HARNESS_LABELS[harness] : harness;
}

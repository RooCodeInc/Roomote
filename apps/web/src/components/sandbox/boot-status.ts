import { RunStatus } from '@roomote/types';

export const getBootStatus = (status: RunStatus): string => {
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
      return `Unknown (${status})`;
  }
};

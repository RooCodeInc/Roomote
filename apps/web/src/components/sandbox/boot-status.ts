import { CloudTaskStatus } from '@roomote/types';

export const getBootStatus = (status: CloudTaskStatus): string => {
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
      return `Unknown (${status})`;
  }
};

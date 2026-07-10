'use client';

import { useCallback } from 'react';
import { SSEProvider } from 'react-hooks-sse';

import { TaskPayloadKind, type CloudTaskStatus } from '@roomote/types';
import type { Run } from '@roomote/db';

import { useRestoreCloudJobSnapshot } from '@/hooks/snapshots';
import { getCloudJobError } from '@/lib/cloud-job-errors';

import { StartupFailureMessage, StartupSequence } from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';

interface StartupProps {
  cloudJobId: number;
  initialCloudJob?: Run;
  onStatusChange?: (status: CloudTaskStatus) => void;
}

export const Startup = ({
  cloudJobId,
  initialCloudJob,
  onStatusChange,
}: StartupProps) => {
  const eventSource = useCallback(() => {
    const eventSource = new EventSource(
      `/api/cloud-jobs/${cloudJobId}/stream`,
      { withCredentials: true },
    );

    eventSource.addEventListener('error', () => eventSource.close());

    return eventSource;
  }, [cloudJobId]);

  return (
    <SSEProvider source={eventSource}>
      <StartupInner
        cloudJobId={cloudJobId}
        initialCloudJob={initialCloudJob}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  cloudJobId: number;
  initialCloudJob?: Run;
  onStatusChange?: (status: CloudTaskStatus) => void;
}

const StartupInner = ({
  cloudJobId,
  initialCloudJob,
  onStatusChange,
}: StartupInnerProps) => {
  const restoreSnapshot = useRestoreCloudJobSnapshot();

  const { steps, error, showLogs, sandboxLogs, logsConnected, logsError } =
    useStartupProgress({ cloudJobId, initialCloudJob, onStatusChange });

  const canRetryResume =
    initialCloudJob?.payloadKind === TaskPayloadKind.SnapshotResume &&
    typeof initialCloudJob.sourceSnapshotId === 'string' &&
    initialCloudJob.sourceSnapshotId.length > 0 &&
    typeof initialCloudJob.sourceRunId === 'number';

  return (
    <StartupSequence
      steps={steps}
      error={error}
      logs={showLogs ? sandboxLogs : undefined}
      logsConnected={logsConnected}
      logsError={logsError}
      retryAction={
        canRetryResume
          ? {
              onClick: () =>
                restoreSnapshot.mutate({
                  sourceSnapshotId: initialCloudJob.sourceSnapshotId!,
                  sourceCloudJobId: initialCloudJob.sourceRunId!,
                }),
              pending: restoreSnapshot.isPending,
            }
          : undefined
      }
    />
  );
};

interface SnapshotResumeFailureFooterProps {
  cloudJob: Pick<
    Run,
    | 'error'
    | 'result'
    | 'sourceRunId'
    | 'sourceSnapshotId'
    | 'status'
    | 'payloadKind'
  >;
}

export const SnapshotResumeFailureFooter = ({
  cloudJob,
}: SnapshotResumeFailureFooterProps) => {
  const restoreSnapshot = useRestoreCloudJobSnapshot();

  const canRetryResume =
    cloudJob.payloadKind === TaskPayloadKind.SnapshotResume &&
    typeof cloudJob.sourceSnapshotId === 'string' &&
    cloudJob.sourceSnapshotId.length > 0 &&
    typeof cloudJob.sourceRunId === 'number';

  return (
    <StartupFailureMessage
      status={cloudJob.status}
      error={getCloudJobError(cloudJob)}
      retryAction={
        canRetryResume
          ? {
              onClick: () =>
                restoreSnapshot.mutate({
                  sourceSnapshotId: cloudJob.sourceSnapshotId!,
                  sourceCloudJobId: cloudJob.sourceRunId!,
                }),
              pending: restoreSnapshot.isPending,
            }
          : undefined
      }
    />
  );
};

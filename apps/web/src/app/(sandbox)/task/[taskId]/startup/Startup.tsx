'use client';

import { useCallback } from 'react';
import { SSEProvider } from 'react-hooks-sse';

import { TaskPayloadKind, type RunStatus } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { useRestoreTaskRunSnapshot } from '@/hooks/snapshots';
import { getTaskRunError } from '@/lib/task-run-errors';

import { StartupFailureMessage, StartupSequence } from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';

interface StartupProps {
  runId: number;
  initialTaskRun?: TaskRun;
  onStatusChange?: (status: RunStatus) => void;
}

export const Startup = ({
  runId,
  initialTaskRun,
  onStatusChange,
}: StartupProps) => {
  const eventSource = useCallback(() => {
    const eventSource = new EventSource(`/api/task-runs/${runId}/stream`, {
      withCredentials: true,
    });

    eventSource.addEventListener('error', () => eventSource.close());

    return eventSource;
  }, [runId]);

  return (
    <SSEProvider source={eventSource}>
      <StartupInner
        runId={runId}
        initialTaskRun={initialTaskRun}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  runId: number;
  initialTaskRun?: TaskRun;
  onStatusChange?: (status: RunStatus) => void;
}

const StartupInner = ({
  runId,
  initialTaskRun,
  onStatusChange,
}: StartupInnerProps) => {
  const restoreSnapshot = useRestoreTaskRunSnapshot();

  const { steps, error, showLogs, sandboxLogs, logsConnected, logsError } =
    useStartupProgress({ runId, initialTaskRun, onStatusChange });

  const canRetryResume =
    initialTaskRun?.payloadKind === TaskPayloadKind.SnapshotResume &&
    typeof initialTaskRun.sourceSnapshotId === 'string' &&
    initialTaskRun.sourceSnapshotId.length > 0 &&
    typeof initialTaskRun.sourceRunId === 'number';

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
                  sourceSnapshotId: initialTaskRun.sourceSnapshotId!,
                  sourceRunId: initialTaskRun.sourceRunId!,
                }),
              pending: restoreSnapshot.isPending,
            }
          : undefined
      }
    />
  );
};

interface SnapshotResumeFailureFooterProps {
  taskRun: Pick<
    TaskRun,
    | 'error'
    | 'result'
    | 'sourceRunId'
    | 'sourceSnapshotId'
    | 'status'
    | 'payloadKind'
  >;
}

export const SnapshotResumeFailureFooter = ({
  taskRun,
}: SnapshotResumeFailureFooterProps) => {
  const restoreSnapshot = useRestoreTaskRunSnapshot();

  const canRetryResume =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
    typeof taskRun.sourceSnapshotId === 'string' &&
    taskRun.sourceSnapshotId.length > 0 &&
    typeof taskRun.sourceRunId === 'number';

  return (
    <StartupFailureMessage
      status={taskRun.status}
      error={getTaskRunError(taskRun)}
      retryAction={
        canRetryResume
          ? {
              onClick: () =>
                restoreSnapshot.mutate({
                  sourceSnapshotId: taskRun.sourceSnapshotId!,
                  sourceRunId: taskRun.sourceRunId!,
                }),
              pending: restoreSnapshot.isPending,
            }
          : undefined
      }
    />
  );
};

'use client';

import { useCallback } from 'react';
import { SSEProvider } from 'react-hooks-sse';

import type { RunStatus as RunStatusValue } from '@roomote/types';
import type { TaskRun } from '@roomote/db';
import type { TaskRunProgress } from '@/types';

import { getTaskRunError } from '@/lib/task-run-errors';

import { StartupFailureMessage, StartupSequence } from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';
import { useRetryFailedTaskStart } from '@/hooks/task-runs';

interface StartupProps {
  runId: number;
  taskId?: string;
  initialTaskRun?: TaskRunProgress;
  canRetryFailedStart?: boolean;
  newTaskHref?: string;
  onStatusChange?: (status: RunStatusValue) => void;
}

export const Startup = ({
  runId,
  taskId,
  initialTaskRun,
  canRetryFailedStart,
  newTaskHref,
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
        taskId={taskId}
        initialTaskRun={initialTaskRun}
        canRetryFailedStart={canRetryFailedStart}
        newTaskHref={newTaskHref}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  runId: number;
  taskId?: string;
  initialTaskRun?: TaskRunProgress;
  canRetryFailedStart?: boolean;
  newTaskHref?: string;
  onStatusChange?: (status: RunStatusValue) => void;
}

const StartupInner = ({
  runId,
  taskId,
  initialTaskRun,
  canRetryFailedStart,
  newTaskHref,
  onStatusChange,
}: StartupInnerProps) => {
  const retryFailedStart = useRetryFailedTaskStart();
  const {
    steps,
    error,
    errorCode,
    showLogs,
    sandboxLogs,
    logsConnected,
    logsError,
  } = useStartupProgress({ runId, initialTaskRun, onStatusChange });

  return (
    <StartupSequence
      steps={steps}
      error={error}
      errorCode={errorCode}
      logs={showLogs ? sandboxLogs : undefined}
      logsConnected={logsConnected}
      logsError={logsError}
      newTaskHref={newTaskHref}
      isRetry={initialTaskRun?.sourceRunId != null}
      onRetry={
        taskId && canRetryFailedStart
          ? () => retryFailedStart.mutate({ taskId, runId })
          : undefined
      }
      retryPending={retryFailedStart.isPending}
    />
  );
};

interface SnapshotResumeFailureFooterProps {
  taskRun: Pick<TaskRun, 'error' | 'result' | 'status'>;
  newTaskHref: string;
}

export const SnapshotResumeFailureFooter = ({
  taskRun,
  newTaskHref,
}: SnapshotResumeFailureFooterProps) => (
  <StartupFailureMessage
    status={taskRun.status}
    error={getTaskRunError(taskRun)}
    newTaskHref={newTaskHref}
  />
);

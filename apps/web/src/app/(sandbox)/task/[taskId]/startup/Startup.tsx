'use client';

import { useCallback } from 'react';
import { SSEProvider } from 'react-hooks-sse';

import type { RunStatus as RunStatusValue } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { getTaskRunError } from '@/lib/task-run-errors';

import { StartupFailureMessage, StartupSequence } from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';

interface StartupProps {
  runId: number;
  initialTaskRun?: TaskRun;
  newTaskHref?: string;
  onStatusChange?: (status: RunStatusValue) => void;
}

export const Startup = ({
  runId,
  initialTaskRun,
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
        initialTaskRun={initialTaskRun}
        newTaskHref={newTaskHref}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  runId: number;
  initialTaskRun?: TaskRun;
  newTaskHref?: string;
  onStatusChange?: (status: RunStatusValue) => void;
}

const StartupInner = ({
  runId,
  initialTaskRun,
  newTaskHref,
  onStatusChange,
}: StartupInnerProps) => {
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

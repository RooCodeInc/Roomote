'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SSEProvider } from 'react-hooks-sse';

import type { RunStatus as RunStatusValue } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { getTaskRunError } from '@/lib/task-run-errors';
import { useReplaceFailedTaskStart } from '@/hooks/task-runs';

import { StartupFailureMessage, StartupSequence } from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';

interface StartupProps {
  runId: number;
  initialTaskRun?: TaskRun;
  prompt?: string;
  onStatusChange?: (status: RunStatusValue) => void;
}

export const Startup = ({
  runId,
  initialTaskRun,
  prompt,
  onStatusChange,
}: StartupProps) => {
  const router = useRouter();
  const replaceFailedStart = useReplaceFailedTaskStart({
    onSuccess: ({ taskId }) => router.push(`/task/${taskId}`),
  });
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
        prompt={prompt}
        onRetry={() => replaceFailedStart.mutate({ runId })}
        retryPending={replaceFailedStart.isPending}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  runId: number;
  initialTaskRun?: TaskRun;
  prompt?: string;
  onRetry: () => void;
  retryPending: boolean;
  onStatusChange?: (status: RunStatusValue) => void;
}

const StartupInner = ({
  runId,
  initialTaskRun,
  prompt,
  onRetry,
  retryPending,
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
      prompt={prompt}
      onRetry={onRetry}
      retryPending={retryPending}
    />
  );
};

interface SnapshotResumeFailureFooterProps {
  taskRun: Pick<TaskRun, 'error' | 'result' | 'status'>;
}

export const SnapshotResumeFailureFooter = ({
  taskRun,
}: SnapshotResumeFailureFooterProps) => (
  <StartupFailureMessage
    status={taskRun.status}
    error={getTaskRunError(taskRun)}
  />
);

'use client';

import { useCallback } from 'react';
import { SSEProvider } from 'react-hooks-sse';

import {
  RunStatus,
  TaskPayloadKind,
  type RunStatus as RunStatusValue,
} from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { useRestoreTaskRunSnapshot } from '@/hooks/snapshots';
import { useRetryFailedTaskStart } from '@/hooks/task-runs';
import { getTaskRunError } from '@/lib/task-run-errors';

import {
  StartupFailureMessage,
  StartupSequence,
  type StartupPromptPreview,
  type StartupRetryAction,
} from './StartupMessage';
import { useStartupProgress } from './useStartupProgress';

/**
 * Client-side eligibility for start retry. Keep in lockstep with
 * `isRelaunchableFailedStartPayloadKind` in packages/cloud-agents.
 */
function canRelaunchFailedStart(
  taskRun: Pick<TaskRun, 'payloadKind' | 'status'>,
): boolean {
  if (taskRun.status !== RunStatus.Failed) {
    return false;
  }

  switch (taskRun.payloadKind) {
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.SlackAppMention:
    case TaskPayloadKind.LinearAgentSession:
    case TaskPayloadKind.GithubPrReviewFollowUp:
    case TaskPayloadKind.McpRecommendations:
      return true;
    default:
      return false;
  }
}

function buildRetryAction(params: {
  taskId: string;
  taskRun?:
    | Pick<
        TaskRun,
        'id' | 'payloadKind' | 'status' | 'sourceRunId' | 'sourceSnapshotId'
      >
    | TaskRun;
  restoreSnapshot: ReturnType<typeof useRestoreTaskRunSnapshot>;
  retryFailedStart: ReturnType<typeof useRetryFailedTaskStart>;
}): StartupRetryAction | undefined {
  const { taskId, taskRun, restoreSnapshot, retryFailedStart } = params;

  if (!taskRun) {
    return undefined;
  }

  const canRetryResume =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
    typeof taskRun.sourceSnapshotId === 'string' &&
    taskRun.sourceSnapshotId.length > 0 &&
    typeof taskRun.sourceRunId === 'number';

  if (canRetryResume) {
    return {
      label: 'Retry resume',
      onClick: () =>
        restoreSnapshot.mutate({
          sourceSnapshotId: taskRun.sourceSnapshotId!,
          sourceRunId: taskRun.sourceRunId!,
        }),
      pending: restoreSnapshot.isPending,
    };
  }

  if (canRelaunchFailedStart(taskRun)) {
    return {
      label: 'Retry',
      onClick: () =>
        retryFailedStart.mutate({
          taskId,
          runId: taskRun.id,
        }),
      pending: retryFailedStart.isPending,
    };
  }

  return undefined;
}

interface StartupProps {
  runId: number;
  taskId: string;
  initialTaskRun?: TaskRun;
  prompt?: StartupPromptPreview | null;
  onStatusChange?: (status: RunStatusValue) => void;
}

export const Startup = ({
  runId,
  taskId,
  initialTaskRun,
  prompt,
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
        prompt={prompt}
        onStatusChange={onStatusChange}
      />
    </SSEProvider>
  );
};

interface StartupInnerProps {
  runId: number;
  taskId: string;
  initialTaskRun?: TaskRun;
  prompt?: StartupPromptPreview | null;
  onStatusChange?: (status: RunStatusValue) => void;
}

const StartupInner = ({
  runId,
  taskId,
  initialTaskRun,
  prompt,
  onStatusChange,
}: StartupInnerProps) => {
  const restoreSnapshot = useRestoreTaskRunSnapshot();
  const retryFailedStart = useRetryFailedTaskStart();

  const {
    steps,
    error,
    elapsedSeconds,
    showLogs,
    sandboxLogs,
    logsConnected,
    logsError,
  } = useStartupProgress({ runId, initialTaskRun, onStatusChange });

  return (
    <StartupSequence
      steps={steps}
      error={error}
      elapsedSeconds={elapsedSeconds}
      logs={showLogs ? sandboxLogs : undefined}
      logsConnected={logsConnected}
      logsError={logsError}
      prompt={prompt}
      retryAction={buildRetryAction({
        taskId,
        taskRun: initialTaskRun,
        restoreSnapshot,
        retryFailedStart,
      })}
    />
  );
};

interface SnapshotResumeFailureFooterProps {
  taskId: string;
  taskRun: Pick<
    TaskRun,
    | 'id'
    | 'error'
    | 'result'
    | 'sourceRunId'
    | 'sourceSnapshotId'
    | 'status'
    | 'payloadKind'
  >;
  prompt?: StartupPromptPreview | null;
}

export const SnapshotResumeFailureFooter = ({
  taskId,
  taskRun,
  prompt,
}: SnapshotResumeFailureFooterProps) => {
  const restoreSnapshot = useRestoreTaskRunSnapshot();
  const retryFailedStart = useRetryFailedTaskStart();

  return (
    <StartupFailureMessage
      status={taskRun.status}
      error={getTaskRunError(taskRun)}
      prompt={prompt}
      retryAction={buildRetryAction({
        taskId,
        taskRun,
        restoreSnapshot,
        retryFailedStart,
      })}
    />
  );
};

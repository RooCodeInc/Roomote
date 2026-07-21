'use client';

import { useEffect, useRef, useState } from 'react';
import { useSSE } from 'react-hooks-sse';

import {
  RunStatus,
  getComputeProviderCapabilities,
  isExitedRunStatus,
  resolveComputeProviderTarget,
} from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { getBootStatus, useSandboxLogs } from '@/components/sandbox';
import { getTaskRunError } from '@/lib/task-run-errors';

import type { StartupStep } from './StartupMessage';

interface UseStartupProgressOptions {
  runId: number;
  initialTaskRun?: TaskRun;
  onStatusChange?: (status: RunStatus) => void;
}

export function useStartupProgress({
  runId,
  initialTaskRun,
  onStatusChange,
}: UseStartupProgressOptions) {
  const initialStatus = initialTaskRun?.status ?? RunStatus.Pending;

  const [steps, setSteps] = useState<StartupStep[]>([
    {
      status: initialStatus,
      completed: isExitedRunStatus(initialStatus),
    },
  ]);

  const streamedTaskRun = useSSE<TaskRun | undefined>('message', undefined);

  const taskRun = streamedTaskRun ?? initialTaskRun;
  const status = taskRun?.status ?? initialStatus;
  const statusRef = useRef(status);
  const error = getTaskRunError(taskRun ?? initialTaskRun);
  const errorCode = (taskRun ?? initialTaskRun)?.errorCode ?? undefined;
  const provider = resolveComputeProviderTarget(
    taskRun?.vendor ?? initialTaskRun?.vendor,
  );
  const canStreamLogs =
    getComputeProviderCapabilities(provider).supportsCommandOutputStreaming;

  const {
    logs: sandboxLogs,
    error: logsError,
    isConnected: logsConnected,
  } = useSandboxLogs({ runId, enabled: canStreamLogs });

  // Update steps when status changes.
  useEffect(() => {
    if (status !== statusRef.current) {
      statusRef.current = status;
      onStatusChange?.(status);
    }

    const displayMessage = getBootStatus(status);
    const isCompleted = isExitedRunStatus(status);

    setSteps((prev) => {
      // Check if a step already maps to this display message.
      const existingIndex = prev.findIndex(
        (item) => getBootStatus(item.status) === displayMessage,
      );

      if (existingIndex >= 0) {
        const updated = [...prev];

        updated[existingIndex] = { status, completed: isCompleted };

        // Mark previous steps as completed.
        for (let i = 0; i < existingIndex; i++) {
          if (updated[i]) {
            updated[i] = { status: updated[i]!.status, completed: true };
          }
        }

        return updated;
      }

      // New step — mark all previous steps as completed.
      const updated = prev.map((step) => ({ ...step, completed: true }));

      return [...updated, { status, completed: isCompleted }];
    });
  }, [status, onStatusChange]);

  const lastStep = steps[steps.length - 1];
  const lastStatus = lastStep?.status ?? RunStatus.Pending;

  return {
    steps,
    lastStatus,
    error: error ?? undefined,
    errorCode,
    showLogs: canStreamLogs,
    sandboxLogs,
    logsConnected,
    logsError,
  };
}

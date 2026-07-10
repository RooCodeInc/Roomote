'use client';

import { useEffect, useRef, useState } from 'react';
import { useSSE } from 'react-hooks-sse';

import {
  RunStatus,
  getComputeProviderCapabilities,
  isExitedRunStatus,
  resolveComputeProviderTarget,
} from '@roomote/types';
import type { Run } from '@roomote/db';

import { getBootStatus, useSandboxLogs } from '@/components/sandbox';
import { getCloudJobError } from '@/lib/cloud-job-errors';

import type { StartupStep } from './StartupMessage';

interface UseStartupProgressOptions {
  cloudJobId: number;
  initialCloudJob?: Run;
  onStatusChange?: (status: RunStatus) => void;
}

export function useStartupProgress({
  cloudJobId,
  initialCloudJob,
  onStatusChange,
}: UseStartupProgressOptions) {
  const initialStatus = initialCloudJob?.status ?? RunStatus.Pending;

  const [steps, setSteps] = useState<StartupStep[]>([
    {
      status: initialStatus,
      completed: isExitedRunStatus(initialStatus),
    },
  ]);

  const streamedCloudJob = useSSE<Run | undefined>('message', undefined);

  const cloudJob = streamedCloudJob ?? initialCloudJob;
  const status = cloudJob?.status ?? initialStatus;
  const statusRef = useRef(status);
  const error = getCloudJobError(cloudJob ?? initialCloudJob);
  const provider = resolveComputeProviderTarget(
    cloudJob?.vendor ?? initialCloudJob?.vendor,
  );
  const canStreamLogs =
    getComputeProviderCapabilities(provider).supportsCommandOutputStreaming;

  const {
    logs: sandboxLogs,
    error: logsError,
    isConnected: logsConnected,
  } = useSandboxLogs({ cloudJobId, enabled: canStreamLogs });

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
    showLogs: canStreamLogs,
    sandboxLogs,
    logsConnected,
    logsError,
  };
}

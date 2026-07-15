'use client';

import { useEffect, useMemo } from 'react';

import {
  getEnvironmentDefinitionIdFromPayload,
  isExitedRunStatus,
} from '@roomote/types';

import {
  hasEnvironmentDefinitionChanged,
  isEnvironmentDefinitionFailureStatus,
  isEnvironmentDefinitionSuccessStatus,
  isEnvironmentDefinitionTerminalSuccessStatus,
} from '@/lib/environment-definition';

import { useEnvironment } from '@/hooks/environments';

import { useTaskSession } from '@/app/(sandbox)/task/[taskId]/hooks';

export type SelectedRepositorySummary = {
  id: string;
  fullName: string;
};

const LINKED_ENVIRONMENT_ID_GRACE_MS = 10_000;

function toTimestamp(value: unknown): number {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    !(value instanceof Date)
  ) {
    return Number.NaN;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

export function useEnvironmentDefinitionAgentState({
  taskId,
  mode,
  environmentId,
  initialEnvironmentDefinitionFingerprint,
}: {
  taskId: string;
  mode: 'create' | 'edit';
  environmentId?: string;
  initialEnvironmentDefinitionFingerprint?: string;
}) {
  const session = useTaskSession(taskId, { refetchInterval: 2_000 });

  const linkedEnvironmentId = useMemo(
    () => getEnvironmentDefinitionIdFromPayload(session.taskRun?.payload),
    [session.taskRun?.payload],
  );

  const linkedEnvironment = useEnvironment(
    mode === 'create' ? (linkedEnvironmentId ?? undefined) : undefined,
  );

  const environment = useEnvironment(
    mode === 'edit' ? environmentId : undefined,
  );

  const refetchLinkedEnvironment = linkedEnvironment.refetch;
  const refetchEnvironment = environment.refetch;
  const matchingEnvironment = mode === 'create' ? linkedEnvironment.data : null;

  const updatedEnvironment =
    mode === 'edit' &&
    hasEnvironmentDefinitionChanged(
      environment.data ?? null,
      initialEnvironmentDefinitionFingerprint,
    )
      ? environment.data
      : null;

  const succeeded =
    !!session.taskRun &&
    isEnvironmentDefinitionSuccessStatus(
      session.taskRun.status,
      session.taskRun.taskPhase,
    ) &&
    (mode === 'create'
      ? matchingEnvironment !== null
      : updatedEnvironment !== null);

  const createEndedWithoutEnvironment =
    mode === 'create' &&
    isEnvironmentDefinitionTerminalSuccessStatus(
      session.taskRun?.status,
      session.taskRun?.taskPhase,
    ) &&
    (!linkedEnvironmentId
      ? (() => {
          const completedAtMs = toTimestamp(session.taskRun?.completedAt);

          return (
            Number.isFinite(completedAtMs) &&
            Date.now() - completedAtMs >= LINKED_ENVIRONMENT_ID_GRACE_MS
          );
        })()
      : linkedEnvironment.isFetched && matchingEnvironment === null);

  const endedWithoutEnvironment =
    !!session.taskRun &&
    isEnvironmentDefinitionTerminalSuccessStatus(
      session.taskRun.status,
      session.taskRun.taskPhase,
    ) &&
    (mode === 'create'
      ? createEndedWithoutEnvironment
      : updatedEnvironment === null);

  const failed =
    !!session.taskRun &&
    (isEnvironmentDefinitionFailureStatus(session.taskRun.status) ||
      endedWithoutEnvironment) &&
    !succeeded;

  const taskIsActive =
    !!session.taskRun && !isExitedRunStatus(session.taskRun.status);

  // Resolve verification state from the linked/updated environment metadata,
  // which is the source of truth for the web UI. Setup/configuration success is
  // distinct from environment verification, which continues asynchronously.
  const resolvedEnvironment =
    mode === 'create' ? matchingEnvironment : updatedEnvironment;

  const verificationSucceeded = resolvedEnvironment?.isVerified === true;
  const verificationFailed =
    !!resolvedEnvironment &&
    !resolvedEnvironment.isVerified &&
    resolvedEnvironment.verificationError !== null &&
    resolvedEnvironment.verificationError !== undefined;
  const verificationPending =
    !!resolvedEnvironment &&
    !resolvedEnvironment.isVerified &&
    !verificationFailed &&
    resolvedEnvironment.verificationTaskId !== null &&
    resolvedEnvironment.verificationTaskId !== undefined &&
    resolvedEnvironment.verificationTaskActive === true;
  const verificationTaskId = resolvedEnvironment?.verificationTaskId ?? null;
  const verificationError = resolvedEnvironment?.verificationError ?? null;

  useEffect(() => {
    // Keep polling while the definition task is unresolved, and also while the
    // environment exists but verification is still pending, so the UI can move
    // from configured -> pending -> verified/failed on its own.
    if ((succeeded || failed) && !verificationPending) {
      return;
    }

    if (mode === 'create') {
      if (!linkedEnvironmentId) {
        return;
      }

      const interval = window.setInterval(() => {
        void refetchLinkedEnvironment();
      }, 2_000);

      return () => window.clearInterval(interval);
    }

    if (!environmentId) {
      return;
    }

    const interval = window.setInterval(() => {
      void refetchEnvironment();
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [
    environmentId,
    failed,
    linkedEnvironmentId,
    mode,
    refetchEnvironment,
    refetchLinkedEnvironment,
    succeeded,
    verificationPending,
  ]);

  return {
    session,
    succeeded,
    failed,
    taskIsActive,
    matchingEnvironment,
    updatedEnvironment,
    verificationSucceeded,
    verificationFailed,
    verificationPending,
    verificationTaskId,
    verificationError,
  };
}

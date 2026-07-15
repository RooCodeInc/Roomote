'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AlertCircle, Spinner } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { type TaskSession, useSandboxConnectionStatus } from './hooks';
import { isTaskRunSnapshotting } from './sidebar-actions/utils';

function getErrorMessage({
  hasConnectedOnce,
  connectionError,
  connectionFailureCategory,
}: {
  hasConnectedOnce: boolean;
  connectionError: boolean;
  connectionFailureCategory: TaskSession['transportErrorCategory'];
}) {
  switch (connectionFailureCategory) {
    case 'auth_error':
      return hasConnectedOnce
        ? 'Could not refresh access to the live task'
        : 'Could not verify access to the live task';
    case 'client_reconnect_failed':
      return 'Could not restore the live task connection';
    case 'backend_unavailable':
      return hasConnectedOnce
        ? 'Could not restore the live task connection'
        : 'Could not reach the live task';
    case 'transport_error':
      return 'Could not connect to the live task';
    default:
      return connectionError
        ? 'Lost connection to the live task'
        : 'Could not connect to the live task';
  }
}

export function ConnectionStatusBanner({ session }: { session: TaskSession }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    connected,
    hasConnectedOnce,
    connectionError,
    connectionFailureCategory,
    reconnecting,
  } = useSandboxConnectionStatus();

  const effectiveFailureCategory =
    connectionFailureCategory ?? session.transportErrorCategory;
  const showReconnectState = reconnecting;
  const showError =
    !showReconnectState && (connectionError || session.hasTransportError);
  const showInitialConnectionState =
    !hasConnectedOnce &&
    (showReconnectState || connectionError || session.hasTransportError);
  const shouldInvalidateSandboxSession =
    showError || (!hasConnectedOnce && connectionError);

  useEffect(() => {
    if (!shouldInvalidateSandboxSession) {
      return;
    }

    queryClient.invalidateQueries({
      queryKey: trpc.sandboxSession.byTaskId.queryKey({
        taskId: session.taskId,
      }),
    });
  }, [queryClient, session.taskId, shouldInvalidateSandboxSession, trpc]);

  if (connected) {
    return null;
  }

  // Sleep transitions tear down the live connection on purpose while the job
  // status still reads as interactive, so a dropped connection here is not a
  // failure. Suppress only while the transcript renders its "Going to sleep"
  // row (snapshot in progress or already taken) so the page never goes
  // statusless: `sleepRequestedAt`-only teardowns keep the banner.
  if (isTaskRunSnapshotting(session.taskRun) || session.taskRun?.snapshotId) {
    return null;
  }

  if (!showReconnectState && !showError) {
    return null;
  }

  if (showInitialConnectionState || showReconnectState) {
    return (
      <div className="border-card border-b">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3">
          <Spinner />
          <span className="text-sm">Trying to connect to the sandbox...</span>
        </div>
      </div>
    );
  }

  if (!showError) {
    return null;
  }

  return (
    <div className="bg-destructive/10 border-card border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3">
        <AlertCircle className="text-destructive size-4 shrink-0" />
        <span className="text-destructive text-sm">
          {getErrorMessage({
            hasConnectedOnce,
            connectionError,
            connectionFailureCategory: effectiveFailureCategory,
          })}
        </span>
      </div>
    </div>
  );
}

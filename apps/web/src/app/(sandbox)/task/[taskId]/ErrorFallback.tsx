'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AlertCircle, RefreshCw, Button } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { type TaskSession, useSandboxConnectionStatus } from './hooks';
import { isTaskRunSnapshotting } from './sidebar-actions/utils';

function getInitialConnectionMessage({
  showReconnectState,
  connectionFailureCategory,
}: {
  showReconnectState: boolean;
  connectionFailureCategory: TaskSession['transportErrorCategory'];
}) {
  if (showReconnectState) {
    return 'Connecting to the live task...';
  }

  switch (connectionFailureCategory) {
    case 'auth_error':
      return 'Could not verify access to the live task';
    case 'backend_unavailable':
      return 'Could not reach the live task';
    case 'transport_error':
      return 'Could not connect to the live task';
    default:
      return 'Live task is taking longer than usual to connect';
  }
}

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

  const [retrying, setRetrying] = useState(false);

  const {
    connected,
    hasConnectedOnce,
    connectionError,
    connectionFailureCategory,
    reconnecting,
    reconnect,
  } = useSandboxConnectionStatus();

  const effectiveFailureCategory =
    connectionFailureCategory ?? session.transportErrorCategory;
  const showReconnectState = reconnecting || retrying;
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

  const handleRetry = useCallback(async () => {
    setRetrying(true);

    try {
      const refreshedConnection = await session.refreshConnection();
      reconnect(refreshedConnection);
    } finally {
      // Give the connection attempt a moment before allowing another retry.
      setTimeout(() => setRetrying(false), 2_000);
    }
  }, [session, reconnect]);

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

  if (showInitialConnectionState) {
    return (
      <div className="bg-muted/40 border-border flex items-center gap-3 border-b px-4 py-2.5">
        <RefreshCw className="text-muted-foreground size-4 shrink-0 animate-spin" />
        <span className="text-muted-foreground text-sm">
          {getInitialConnectionMessage({
            showReconnectState,
            connectionFailureCategory: effectiveFailureCategory,
          })}
        </span>
        {!showReconnectState ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={retrying}
            onClick={handleRetry}
          >
            <RefreshCw
              className={`mr-1.5 size-3.5 ${retrying ? 'animate-spin' : ''}`}
            />
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  if (showReconnectState) {
    return (
      <div className="bg-muted/40 border-border flex items-center gap-3 border-b px-4 py-2.5">
        <RefreshCw className="text-muted-foreground size-4 shrink-0 animate-spin" />
        <span className="text-muted-foreground text-sm">
          Reconnecting to the live task...
        </span>
      </div>
    );
  }

  if (!showError) {
    return null;
  }

  return (
    <div className="bg-destructive/10 border-destructive/30 flex items-center gap-3 border-b px-4 py-2.5">
      <AlertCircle className="text-destructive size-4 shrink-0" />
      <span className="text-destructive text-sm">
        {getErrorMessage({
          hasConnectedOnce,
          connectionError,
          connectionFailureCategory: effectiveFailureCategory,
        })}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        disabled={retrying}
        onClick={handleRetry}
      >
        <RefreshCw
          className={`mr-1.5 size-3.5 ${retrying ? 'animate-spin' : ''}`}
        />
        {retrying ? 'Reconnecting...' : 'Reconnect'}
      </Button>
    </div>
  );
}

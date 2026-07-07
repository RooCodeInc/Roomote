'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/nextjs';

import type { AcpMessage, TaskStatusEvent } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { clearLiveTaskStatus, setLiveTaskStatus } from '@/hooks/tasks';
import type { TaskMessageEnvelope } from '@/types';

import type { SandboxConnectionTarget } from './use-cloud-session';
import type { createSandboxStore } from './use-sandbox-store';
import { replaceOptimisticPromptEnvelope } from './services/optimistic-prompt-envelope-state';
import {
  classifySandboxConnectionFailureCategory,
  classifySandboxTransportErrorCategory,
} from './services/sandbox-live-connection-diagnostics';
import { startSandboxLiveAutoRecovery } from './services/sandbox-live-auto-recovery';
import { createSandboxLiveEventApplier } from './services/sandbox-live-event-application';
import {
  clearSandboxReconnectRetryBudget,
  createSandboxReconnectRetryState,
  isClearlyTerminalReconnectError,
  markSandboxReconnectConnected,
  markSandboxReconnectExhaustionReported,
  planSandboxReconnect,
} from './services/sandbox-live-retry-policy';
import { useSandboxLiveTransport } from './use-sandbox-live-transport';

export type SandboxReconnect = (
  connectionTarget?: SandboxConnectionTarget | null,
) => void;

const CONNECTION_TIMEOUT_MS = 5_000;

interface UseSandboxLiveConnectionOptions {
  taskId: string;
  url: string | undefined | null;
  token: string | undefined;
  refreshConnection?: () => Promise<SandboxConnectionTarget | null>;
  historyReady: boolean;
  store: ReturnType<typeof createSandboxStore>;
  titleRefreshTimerRef: {
    current: ReturnType<typeof setTimeout> | null;
  };
}

// tRPC owns the websocket primitive; this hook owns the Roomote-specific
// connection target refresh and store/query-cache sync around that transport.
export function useSandboxLiveConnection({
  taskId,
  url,
  token,
  refreshConnection,
  historyReady,
  store,
  titleRefreshTimerRef,
}: UseSandboxLiveConnectionOptions): SandboxReconnect {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const retryStateRef = useRef(createSandboxReconnectRetryState());
  const { client, tokenRef, urlRef, restartTransport, transportCloseRef } =
    useSandboxLiveTransport({
      taskId,
      url,
      token,
      store,
    });

  useEffect(() => {
    retryStateRef.current = createSandboxReconnectRetryState();
    store.getState()._setHasConnectedOnce(false);
    store.getState()._setConnectionFailureCategory(null);
    store.getState()._setReconnecting(false);
  }, [store, taskId]);

  const connectRef = useRef<(() => void) | null>(null);
  const syncSessionAfterLiveTargetLoss = useCallback(() => {
    store.getState()._setConnected(false);
    store.getState()._setConnectionError(false);
    store.getState()._setConnectionFailureCategory(null);
    store.getState()._setReconnecting(false);

    void queryClient.invalidateQueries({
      queryKey: trpc.sandboxSession.byTaskId.queryKey({ taskId }),
    });
  }, [queryClient, store, taskId, trpc.sandboxSession.byTaskId]);

  useEffect(() => {
    if (!client || !historyReady) {
      return;
    }

    let cancelled = false;
    let connectionTimeout: ReturnType<typeof setTimeout>;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let sandboxSub: { unsubscribe: () => void } | null = null;
    let activeAttemptToken = 0;
    const publishTaskStatus = (status: TaskStatusEvent) => {
      setLiveTaskStatus(taskId, status);
    };
    const replaceOptimisticPrompt = (event: AcpMessage) => {
      const queryKey = trpc.tasks.messageEnvelopes.queryKey({ taskId });

      queryClient.setQueryData<TaskMessageEnvelope[] | undefined>(
        queryKey,
        (current) => replaceOptimisticPromptEnvelope(current, taskId, event),
      );
    };
    const scheduleTitleRefresh = () => {
      if (titleRefreshTimerRef.current) {
        clearTimeout(titleRefreshTimerRef.current);
      }

      titleRefreshTimerRef.current = setTimeout(() => {
        titleRefreshTimerRef.current = null;

        void queryClient.invalidateQueries({
          queryKey: trpc.sandboxSession.byTaskId.queryKey({ taskId }),
        });

        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.list.queryKey(),
        });

        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.messageEnvelopes.queryKey({ taskId }),
        });
      }, 5_000);
    };
    const eventApplier = createSandboxLiveEventApplier({
      store,
      publishTaskStatus,
      invalidateSandboxSession: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.sandboxSession.byTaskId.queryKey({ taskId }),
        });
      },
      invalidateMessageEnvelopes: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.messageEnvelopes.queryKey({ taskId }),
        });
      },
      replaceOptimisticPrompt,
      scheduleTitleRefresh,
    });
    const cleanup = () => {
      clearTimeout(connectionTimeout);
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      sandboxSub?.unsubscribe();
      sandboxSub = null;
    };

    const handleConnectionFailure = (
      message: string,
      options?: { error?: unknown },
    ) => {
      const retryToken = ++activeAttemptToken;

      cleanup();
      store.getState()._setConnected(false);
      clearLiveTaskStatus(taskId);

      if (cancelled) {
        return;
      }

      const retryPlan = planSandboxReconnect(retryStateRef.current);
      retryStateRef.current = retryPlan.nextState;
      const closeCode = transportCloseRef.current.code;
      const closeReason =
        transportCloseRef.current.reason ??
        (options?.error instanceof Error
          ? options.error.message
          : options?.error !== undefined
            ? String(options.error)
            : message);

      const logFailure = (logMessage: string) => {
        const logContext = {
          hasToken: !!tokenRef.current,
          url: urlRef.current,
          closeCode: closeCode ?? null,
          closeReason,
          taskId,
          reconnectPhase: retryPlan.phase,
          reconnectAttempt:
            retryPlan.kind === 'retry' ? retryPlan.attempt : null,
        };

        if (options?.error === undefined) {
          console.warn(logMessage, logContext);
          return;
        }

        console.warn(logMessage, logContext, options.error);
      };

      Sentry.addBreadcrumb({
        category: 'sandbox.websocket',
        level: 'warning',
        message,
        data: {
          taskId,
          url: urlRef.current ?? undefined,
          closeCode,
          closeReason,
          reconnectPhase: retryPlan.phase,
          reconnectAttempt:
            retryPlan.kind === 'retry' ? retryPlan.attempt : undefined,
          reconnectMaxAttempts:
            retryPlan.kind === 'retry' ? retryPlan.maxAttempts : undefined,
          failureCategory:
            retryPlan.kind === 'exhausted'
              ? classifySandboxConnectionFailureCategory({
                  phase: retryPlan.phase,
                  reason: closeReason,
                })
              : retryPlan.phase === 'established'
                ? 'transient_disconnect'
                : 'initial_connect_retry',
        },
      });

      if (retryPlan.kind === 'exhausted') {
        const failureCategory = classifySandboxConnectionFailureCategory({
          phase: retryPlan.phase,
          reason: closeReason,
        });
        // Auto-recovery restarts the retry chain indefinitely, so report each
        // disconnection episode only once; repeats would just duplicate the
        // same Sentry event and warning every recovery cycle.
        const alreadyReported = retryStateRef.current.hasReportedExhaustion;
        retryStateRef.current = markSandboxReconnectExhaustionReported(
          retryStateRef.current,
        );

        if (!alreadyReported) {
          if (retryPlan.phase === 'established') {
            logFailure(`${message}; reconnect retries exhausted`);
          } else {
            logFailure(`${message}; initial connection retries exhausted`);
          }

          Sentry.withScope((scope) => {
            scope.setTag('roomote.task_id', taskId);
            scope.setContext('sandboxConnection', {
              taskId,
              url: urlRef.current,
              closeCode: closeCode ?? null,
              closeReason,
              failureCategory,
              phase: retryPlan.phase,
              hasToken: !!tokenRef.current,
            });

            Sentry.captureMessage(
              'Sandbox live connection retries exhausted',
              'warning',
            );
          });
        }

        store.getState()._setReconnecting(false);
        store.getState()._setConnectionFailureCategory(failureCategory);
        store.getState()._setConnectionError(true);
        return;
      }

      if (retryPlan.phase === 'established') {
        logFailure(
          `${message}; retrying established connection in ${retryPlan.delayMs}ms (${retryPlan.attempt}/${retryPlan.maxAttempts})`,
        );
        store.getState()._setReconnecting(true);
      } else {
        logFailure(`${message}; retrying initial connection`);
        store.getState()._setReconnecting(false);
      }

      store.getState()._setConnectionError(false);

      reconnectTimeout = setTimeout(() => {
        if (cancelled || retryToken !== activeAttemptToken) {
          return;
        }

        void (refreshConnection?.() ?? Promise.resolve(null))
          .then((nextConnectionTarget) => {
            if (cancelled || retryToken !== activeAttemptToken) {
              return;
            }

            if (nextConnectionTarget === null) {
              syncSessionAfterLiveTargetLoss();
              return;
            }

            restartTransport(nextConnectionTarget);
          })
          .catch((error) => {
            if (cancelled || retryToken !== activeAttemptToken) {
              return;
            }

            if (isClearlyTerminalReconnectError(error)) {
              const failureCategory =
                classifySandboxTransportErrorCategory(error);
              logFailure(
                retryPlan.phase === 'established'
                  ? '[SandboxProvider] failed to refresh sandbox connection before retry; reconnect refresh failure appears terminal'
                  : '[SandboxProvider] failed to refresh sandbox connection before retry; initial refresh failure appears terminal',
              );
              Sentry.addBreadcrumb({
                category: 'sandbox.websocket',
                level: 'warning',
                message: 'sandbox connection refresh failed',
                data: {
                  taskId,
                  url: urlRef.current ?? undefined,
                  reconnectPhase: retryPlan.phase,
                  failureCategory,
                },
              });
              store.getState()._setReconnecting(false);
              store.getState()._setConnectionFailureCategory(failureCategory);
              store.getState()._setConnectionError(true);
              return;
            }

            console.warn(
              '[SandboxProvider] failed to refresh sandbox connection before retry',
              error,
            );

            restartTransport();
          });
      }, retryPlan.delayMs);
    };

    const connect = () => {
      cleanup();
      const attemptToken = ++activeAttemptToken;
      store.getState()._setConnectionError(false);
      store.getState()._setConnectionFailureCategory(null);

      let connected = false;

      connectionTimeout = setTimeout(() => {
        if (!connected && !cancelled && attemptToken === activeAttemptToken) {
          handleConnectionFailure(
            '[SandboxProvider] Connection timeout — no response from server',
          );
        }
      }, CONNECTION_TIMEOUT_MS);

      const onError = (error: unknown) => {
        if (attemptToken !== activeAttemptToken) {
          return;
        }

        if (!cancelled) {
          transportCloseRef.current = {
            ...transportCloseRef.current,
            reason:
              error instanceof Error ? error.message : String(error ?? ''),
          };
          const message =
            error instanceof Error ? error.message : String(error);
          handleConnectionFailure(
            `[SandboxProvider] subscription error: ${message}`,
            { error },
          );
        }
      };

      sandboxSub = client.commands.sandboxStream.subscribe(undefined, {
        onStarted: () => {
          if (attemptToken !== activeAttemptToken) {
            return;
          }

          connected = true;
          transportCloseRef.current = {
            ...transportCloseRef.current,
            code: undefined,
            reason: undefined,
          };
          retryStateRef.current = markSandboxReconnectConnected(
            retryStateRef.current,
          );
          console.log('[SandboxProvider] connected (ws)');
          clearTimeout(connectionTimeout);
          store.getState()._setConnected(true);
          store.getState()._setHasConnectedOnce(true);
          store.getState()._setConnectionError(false);
          store.getState()._setConnectionFailureCategory(null);
          store.getState()._setReconnecting(false);
          const syncPoint = eventApplier.captureSyncPoint();

          void client.commands.getRuntimeState
            .query()
            .then((runtimeState) => {
              if (cancelled || attemptToken !== activeAttemptToken) {
                return;
              }

              eventApplier.applyRuntimeState(runtimeState, syncPoint);
            })
            .catch((error) => {
              if (!cancelled) {
                console.warn(
                  '[SandboxProvider] failed to sync runtime state after connect',
                  error,
                );
              }
            });
        },
        onData: (event) => {
          if (attemptToken !== activeAttemptToken) {
            return;
          }

          eventApplier.applyEvent(event);
        },
        onError,
        onComplete: () => {
          if (attemptToken !== activeAttemptToken) {
            return;
          }

          if (!cancelled) {
            transportCloseRef.current = {
              ...transportCloseRef.current,
              reason: 'subscription closed by server',
            };
            handleConnectionFailure(
              '[SandboxProvider] subscription closed by server',
            );
          }
        },
      });
    };

    connectRef.current = connect;
    connect();

    return () => {
      cancelled = true;
      connectRef.current = null;
      cleanup();
      activeAttemptToken += 1;

      if (titleRefreshTimerRef.current) {
        clearTimeout(titleRefreshTimerRef.current);
        titleRefreshTimerRef.current = null;
      }

      store.getState()._setConnected(false);
      store.getState()._setConnectionError(false);
      store.getState()._setConnectionFailureCategory(null);
      store.getState()._setReconnecting(false);
      store.getState()._setTaskStatus(null);
      clearLiveTaskStatus(taskId);
    };
  }, [
    store,
    client,
    historyReady,
    taskId,
    refreshConnection,
    queryClient,
    trpc.sandboxSession.byTaskId,
    trpc.tasks.messageEnvelopes,
    trpc.tasks.list,
    restartTransport,
    syncSessionAfterLiveTargetLoss,
    titleRefreshTimerRef,
    tokenRef,
    transportCloseRef,
    urlRef,
  ]);

  const reconnect = useCallback<SandboxReconnect>(
    (connectionTarget) => {
      if (connectionTarget === null) {
        retryStateRef.current = clearSandboxReconnectRetryBudget(
          retryStateRef.current,
        );
        syncSessionAfterLiveTargetLoss();
        return;
      }

      if (connectionTarget === undefined && !connectRef.current) {
        return;
      }

      retryStateRef.current = clearSandboxReconnectRetryBudget(
        retryStateRef.current,
      );
      store.getState()._setConnectionError(false);
      store.getState()._setConnectionFailureCategory(null);
      store.getState()._setReconnecting(true);

      if (connectionTarget !== undefined) {
        restartTransport(connectionTarget);
        return;
      }

      connectRef.current?.();
    },
    [restartTransport, store, syncSessionAfterLiveTargetLoss],
  );

  // An exhausted retry budget would otherwise leave the page disconnected
  // until the user clicks Reconnect, even after transient client-side blips
  // like laptop sleep or a network switch.
  useEffect(
    () =>
      startSandboxLiveAutoRecovery({
        isEligible: () => {
          const state = store.getState();

          return (
            state.connectionError && !state.connected && !state.reconnecting
          );
        },
        triggerReconnect: () => reconnect(),
      }),
    [store, reconnect],
  );

  return reconnect;
}

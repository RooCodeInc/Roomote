'use client';

import { type ReactNode, useEffect, useRef } from 'react';

import {
  type RunStatus,
  type CodingHarness,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type TaskPhase,
  type TaskStatusEvent,
} from '@roomote/types';

import { Loading } from '@/components/layout';

import { SandboxStoreContext } from './SandboxProvider';
import { createSandboxStore } from './use-sandbox-store';
import type { TaskMessageEnvelopesQueryState } from './use-task-message-envelopes';
import { shouldMarkTrailingAssistantCompletion } from './trailing-assistant-completion';

function getHistoricalTaskStatus(
  taskPhase: TaskPhase | null | undefined,
): TaskStatusEvent | null {
  if (!taskPhase) {
    return null;
  }

  return {
    phase: taskPhase,
    taskStateEvent: null,
    sessionId: undefined,
    isConnected: false,
    sleepRemainingMs: null,
    lastErrorMessage: undefined,
  };
}

interface HistoricalSandboxProviderProps {
  /**
   * The task ID to fetch messages for.
   * If null, the job failed before a task was created.
   */
  taskId: string | null;
  history: TaskMessageEnvelopesQueryState;

  /**
   * The harness used to generate the messages.
   */
  harness: CodingHarness;

  /**
   * Persisted runtime state used to infer whether a trailing assistant
   * transcript segment represents a completed turn.
   */
  taskStatus?: RunStatus | null;
  taskPhase?: TaskPhase | null;

  /**
   * Content to render when messages are loading.
   */
  fallback?: ReactNode;

  /**
   * The main content to render once messages are loaded.
   */
  children: ReactNode;
}

/**
 * Provider for viewing historical/archived sandbox sessions.
 *
 * Unlike SandboxProvider, this does not establish a live connection.
 * Instead, it fetches messages and hydrates the store  for read-only display.
 */
export function HistoricalSandboxProvider({
  taskId,
  history,
  harness,
  taskStatus,
  taskPhase,
  fallback,
  children,
}: HistoricalSandboxProviderProps) {
  const storeRef = useRef<ReturnType<typeof createSandboxStore>>(undefined);
  const persistedTaskStatus = getHistoricalTaskStatus(taskPhase);
  void harness;

  if (!storeRef.current) {
    const store = createSandboxStore();
    store.getState()._setTaskStatus(persistedTaskStatus);
    storeRef.current = store;
  }

  const store = storeRef.current;

  useEffect(() => store.getState()._setReadOnly(true), [store]);

  useEffect(
    () => store.getState()._setProtocol(ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
    [store],
  );

  useEffect(
    () => store.getState()._setTaskStatus(persistedTaskStatus),
    [store, persistedTaskStatus],
  );

  useEffect(() => {
    if (history.data) {
      store.getState()._loadAcpHistory(history.data, {
        markTrailingAssistantCompletion: shouldMarkTrailingAssistantCompletion({
          taskStatus,
          taskPhase,
        }),
      });
    }
  }, [store, history.data, taskStatus, taskPhase]);

  const isPending = history.isPending;

  return isPending && !!taskId ? (
    <SandboxStoreContext.Provider value={store}>
      {fallback ?? <Loading layout="centered" className="flex-1" />}
    </SandboxStoreContext.Provider>
  ) : (
    <SandboxStoreContext.Provider value={store}>
      {children}
    </SandboxStoreContext.Provider>
  );
}

'use client';

import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import {
  type RunStatus,
  type TaskPhase,
  type AcpPlanTodo,
  type TaskStatusEvent,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import { useUser } from '@/hooks/useUser';

import type { SandboxClient, AcpUiMessage, QueuedMessage } from '../types';

import type { AcpUserInfo } from './services/acp-protocol-service';
import type { AcpContextUsage } from './services/acp-usage';
import type { SandboxConnectionFailureCategory } from './services/sandbox-live-connection-diagnostics';
import type { PendingTaskUserInputRequest } from './services/user-input-request-state';
import type { PendingTaskEnvVarRequest } from './task-env-var-request-state';
import type { SandboxConnectionTarget } from './use-task-session';
import {
  getPendingTaskEnvVarRequest,
  isPendingTaskEnvVarLifecycleEvent,
} from './task-env-var-request-state';

import { shouldMarkTrailingAssistantCompletion } from './trailing-assistant-completion';
import { type TaskStatus, createSandboxStore } from './use-sandbox-store';
import type { TaskMessageEnvelopesQueryState } from './use-task-message-envelopes';
import {
  type SandboxReconnect,
  useSandboxLiveConnection,
} from './use-sandbox-live-connection';

const SandboxReconnectContext = createContext<SandboxReconnect>(() => {});
export const SandboxHistoryReadyContext = createContext(false);

type SandboxTaskPhase = TaskStatus['phase'];

// SandboxProvider

interface SandboxProviderProps {
  taskId: string;
  url: string | undefined | null;
  token: string | undefined;
  refreshConnection?: () => Promise<SandboxConnectionTarget | null>;
  history: Pick<
    TaskMessageEnvelopesQueryState,
    'data' | 'isSuccess' | 'isError'
  >;
  initialTaskStatus?: RunStatus | null;
  initialTaskPhase?: TaskPhase | null;
  /** @deprecated Workspace content now renders while transcript history hydrates. */
  fallback?: ReactNode;
  children: ReactNode;
}

export function SandboxProvider({
  taskId,
  url,
  token,
  refreshConnection,
  history,
  initialTaskStatus,
  initialTaskPhase,
  children,
}: SandboxProviderProps) {
  const { user } = useUser();

  const titleRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const currentUserInfo = useMemo<AcpUserInfo | null>(
    () =>
      user
        ? {
            userId: user.userId,
            userName: user.name,
            userEmail:
              user.primaryEmail ??
              user.resource.primaryEmailAddress?.emailAddress ??
              null,
            userImageUrl: user.resource.imageUrl,
          }
        : null,
    [user],
  );
  const storeRef = useRef<ReturnType<typeof createSandboxStore>>(undefined);

  if (!storeRef.current) {
    storeRef.current = createSandboxStore(currentUserInfo);
  }

  const store = storeRef.current;

  const persistedTaskStatus = useMemo(
    () => getPersistedTaskStatus(initialTaskPhase),
    [initialTaskPhase],
  );

  const historyHydratedRef = useRef(false);
  const [historyReady, setHistoryReady] = useState(false);

  useLayoutEffect(() => {
    store.getState()._setCurrentUser(currentUserInfo);
  }, [store, currentUserInfo]);

  useLayoutEffect(() => {
    if (store.getState().connected) {
      return;
    }

    store.getState()._setTaskStatus(persistedTaskStatus);
  }, [store, persistedTaskStatus, taskId]);

  useEffect(() => {
    historyHydratedRef.current = false;
    setHistoryReady(false);
  }, [store, taskId]);

  useEffect(() => {
    if (history.isSuccess && !historyHydratedRef.current) {
      store.getState()._loadAcpHistory(history.data ?? [], {
        markTrailingAssistantCompletion: shouldMarkTrailingAssistantCompletion({
          taskStatus: initialTaskStatus,
          taskPhase: initialTaskPhase,
        }),
      });

      historyHydratedRef.current = true;
      setHistoryReady(true);
      return;
    }

    if (history.isError) {
      historyHydratedRef.current = true;
      setHistoryReady(true);
    }
  }, [
    history.data,
    history.isError,
    history.isSuccess,
    store,
    taskId,
    initialTaskStatus,
    initialTaskPhase,
  ]);

  useEffect(() => {
    if (!historyHydratedRef.current || !history.isSuccess) {
      return;
    }

    const envelopes = history.data ?? [];
    store.getState()._mergeAcpHistory(envelopes);

    const pendingEnvVarRequest = getPendingTaskEnvVarRequest(envelopes);

    if (pendingEnvVarRequest) {
      store.getState()._syncPendingEnvVarRequest(pendingEnvVarRequest);
      return;
    }

    const hasEnvVarLifecycleEvent = envelopes.some((envelope) =>
      isPendingTaskEnvVarLifecycleEvent({
        eventType: envelope.eventType,
        payload: (envelope.payload as Record<string, unknown> | null) ?? null,
      }),
    );

    if (hasEnvVarLifecycleEvent) {
      store.getState()._syncPendingEnvVarRequest(null);
    }
  }, [history.data, history.isSuccess, store]);

  useEffect(
    () => store.getState()._setProtocol(ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
    [store],
  );

  const reconnect = useSandboxLiveConnection({
    taskId,
    url,
    token,
    refreshConnection,
    historyReady,
    store,
    titleRefreshTimerRef,
  });

  return (
    <SandboxReconnectContext.Provider value={reconnect}>
      <SandboxHistoryReadyContext.Provider value={historyReady}>
        <SandboxStoreContext.Provider value={store}>
          {children}
        </SandboxStoreContext.Provider>
      </SandboxHistoryReadyContext.Provider>
    </SandboxReconnectContext.Provider>
  );
}

// SandboxStoreContext

export const SandboxStoreContext = createContext<ReturnType<
  typeof createSandboxStore
> | null>(null);

function useSandboxStore() {
  const store = useContext(SandboxStoreContext);

  if (!store) {
    throw new Error(
      'useSandbox* hooks must be used within a <SandboxProvider> or <HistoricalSandboxProvider>',
    );
  }

  return store;
}

function useOptionalSandboxStore() {
  return useContext(SandboxStoreContext);
}

// Selector Hooks

export function useSandboxMessages(): {
  messages: AcpUiMessage[];
  protocol: typeof ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL;
} {
  const store = useSandboxStore();

  return useStore(
    store,
    useShallow((s) => ({
      messages: s.messages,
      protocol: s.protocol,
    })),
  );
}

export function useSandboxHistoryReady(): boolean {
  return useContext(SandboxHistoryReadyContext);
}

/** Cheap length-only selector so consumers don't re-render per message body. */
export function useSandboxMessageCount(): number {
  const store = useSandboxStore();
  return useStore(store, (s) => s.messages.length);
}

export function useSandboxClient(): SandboxClient | null {
  const store = useSandboxStore();
  return useStore(store, (s) => s.client);
}

export function useSandboxAppendAcpEvent() {
  const store = useSandboxStore();
  return useStore(store, (s) => s._handleAcpEvent);
}

export function useSandboxAppendOptimisticAcpEvent() {
  const store = useSandboxStore();
  return useStore(store, (s) => s._appendOptimisticAcpEvent);
}

export function useSandboxAppendOptimisticQueuedMessage() {
  const store = useSandboxStore();
  return useStore(store, (s) => s._appendOptimisticQueuedMessage);
}

export function useSandboxRemoveOptimisticMessage() {
  const store = useSandboxStore();
  return useStore(store, (s) => s._removeOptimisticMessageByClientMessageId);
}

export function useSandboxRemoveOptimisticQueuedMessage() {
  const store = useSandboxStore();
  return useStore(
    store,
    (s) => s._removeOptimisticQueuedMessageByClientMessageId,
  );
}

export function useSandboxCurrentUserInfo(): AcpUserInfo | null {
  const store = useSandboxStore();
  return useStore(store, (s) => s.currentUserInfo);
}

export function useSandboxConnected(): boolean {
  const store = useSandboxStore();
  return useStore(store, (s) => s.connected);
}

export function useSandboxConnectionStatus(): {
  connected: boolean;
  hasConnectedOnce: boolean;
  connectionError: boolean;
  connectionFailureCategory: SandboxConnectionFailureCategory | null;
  reconnecting: boolean;
  reconnect: SandboxReconnect;
} {
  const store = useSandboxStore();
  const reconnect = useContext(SandboxReconnectContext);

  const state = useStore(
    store,
    useShallow((s) => ({
      connected: s.connected,
      hasConnectedOnce: s.hasConnectedOnce,
      connectionError: s.connectionError,
      connectionFailureCategory: s.connectionFailureCategory,
      reconnecting: s.reconnecting,
    })),
  );

  return {
    ...state,
    reconnect,
  };
}

export function useSandboxTaskPhase(): SandboxTaskPhase | null {
  const store = useSandboxStore();
  return useStore(store, (s) => s.taskStatus?.phase ?? null);
}

export function useSandboxTaskStatusDisplay(): {
  phase: SandboxTaskPhase | null;
  lastErrorMessage: string | undefined;
} {
  const store = useSandboxStore();

  return useStore(
    store,
    useShallow((s) => ({
      phase: s.taskStatus?.phase ?? null,
      lastErrorMessage: s.taskStatus?.lastErrorMessage,
    })),
  );
}

export function useSandboxConnection(): {
  sandboxUrl: string | null;
  sandboxToken: string | undefined;
} {
  const store = useSandboxStore();

  return useStore(
    store,
    useShallow((s) => ({
      sandboxUrl: s.sandboxUrl,
      sandboxToken: s.sandboxToken,
    })),
  );
}

export function useSandboxTodos(): AcpPlanTodo[] {
  const store = useSandboxStore();

  return useStore(store, (s) => s.todos);
}

export function useSandboxAcpUsage(): AcpContextUsage | null {
  const store = useSandboxStore();

  return useStore(store, (s) => s.acpUsage);
}

export function useSandboxQueuedMessages(): QueuedMessage[] {
  const store = useSandboxStore();

  return useStore(store, (s) => s.queuedMessages);
}

export function useSandboxPendingUserInputRequests(): PendingTaskUserInputRequest[] {
  const store = useSandboxStore();

  return useStore(store, (s) => s.pendingUserInputRequests);
}

export function useSandboxPendingEnvVarRequest(): PendingTaskEnvVarRequest | null {
  const store = useSandboxStore();

  return useStore(store, (s) => s.pendingEnvVarRequest);
}

export function useIsInsideSandboxProvider(): boolean {
  const store = useOptionalSandboxStore();
  return store !== null;
}

export function useSandboxReadOnly(): boolean {
  const store = useSandboxStore();

  return useStore(store, (s) => s.readOnly);
}

/**
 * Captures the conversation's reasoning-expanded override at mount time so each
 * ReasoningMessage block initialises its local open/close state once.
 * A null value lets the personal default apply until the user manually changes
 * a reasoning block; later overrides only affect newly mounted blocks.
 */
export function useInitialSandboxReasoningExpanded(): boolean | null {
  const store = useSandboxStore();
  const initialValueRef = useRef(store.getState().reasoningExpanded);
  return initialValueRef.current;
}

export function useSandboxSetReasoningExpanded(): (expanded: boolean) => void {
  const store = useSandboxStore();
  return useStore(store, (s) => s.setReasoningExpanded);
}

// Helpers

function getPersistedTaskStatus(
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

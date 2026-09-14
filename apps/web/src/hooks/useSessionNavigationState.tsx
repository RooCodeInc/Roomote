'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type SessionNavigationState = {
  getDraft: (sessionId: string) => string;
  setDraft: (sessionId: string, draft: string) => void;
  getScrollPosition: (sessionId: string) => number | undefined;
  setScrollPosition: (sessionId: string, scrollTop: number) => void;
  getDismissedTaskPanelIds: (sessionId: string) => ReadonlySet<string>;
  setTaskPanelDismissed: (
    sessionId: string,
    taskId: string,
    dismissed: boolean,
  ) => void;
  prepareSessionSwitch: (sessionId: string) => void;
  consumeSessionSwitch: (sessionId: string) => boolean;
};

const SessionNavigationStateContext =
  createContext<SessionNavigationState | null>(null);

export function SessionNavigationStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const draftsRef = useRef(new Map<string, string>());
  const scrollPositionsRef = useRef(new Map<string, number>());
  const dismissedTaskPanelIdsRef = useRef(new Map<string, Set<string>>());
  const pendingSwitchesRef = useRef(new Set<string>());

  const getDraft = useCallback(
    (sessionId: string) => draftsRef.current.get(sessionId) ?? '',
    [],
  );
  const setDraft = useCallback((sessionId: string, draft: string) => {
    if (draft) draftsRef.current.set(sessionId, draft);
    else draftsRef.current.delete(sessionId);
  }, []);
  const getScrollPosition = useCallback(
    (sessionId: string) => scrollPositionsRef.current.get(sessionId),
    [],
  );
  const setScrollPosition = useCallback(
    (sessionId: string, scrollTop: number) => {
      scrollPositionsRef.current.set(sessionId, scrollTop);
    },
    [],
  );
  const getDismissedTaskPanelIds = useCallback(
    (sessionId: string) =>
      dismissedTaskPanelIdsRef.current.get(sessionId) ?? new Set<string>(),
    [],
  );
  const setTaskPanelDismissed = useCallback(
    (sessionId: string, taskId: string, dismissed: boolean) => {
      const dismissedTaskPanelIds =
        dismissedTaskPanelIdsRef.current.get(sessionId) ?? new Set<string>();
      if (dismissed) {
        dismissedTaskPanelIds.add(taskId);
        dismissedTaskPanelIdsRef.current.set(sessionId, dismissedTaskPanelIds);
      } else {
        dismissedTaskPanelIds.delete(taskId);
        if (dismissedTaskPanelIds.size === 0) {
          dismissedTaskPanelIdsRef.current.delete(sessionId);
        }
      }
    },
    [],
  );
  const prepareSessionSwitch = useCallback((sessionId: string) => {
    pendingSwitchesRef.current.add(sessionId);
  }, []);
  const consumeSessionSwitch = useCallback((sessionId: string) => {
    const isSwitch = pendingSwitchesRef.current.has(sessionId);
    pendingSwitchesRef.current.delete(sessionId);
    return isSwitch;
  }, []);

  const value = useMemo(
    () => ({
      getDraft,
      setDraft,
      getScrollPosition,
      setScrollPosition,
      getDismissedTaskPanelIds,
      setTaskPanelDismissed,
      prepareSessionSwitch,
      consumeSessionSwitch,
    }),
    [
      consumeSessionSwitch,
      getDraft,
      getDismissedTaskPanelIds,
      getScrollPosition,
      prepareSessionSwitch,
      setDraft,
      setScrollPosition,
      setTaskPanelDismissed,
    ],
  );

  return (
    <SessionNavigationStateContext.Provider value={value}>
      {children}
    </SessionNavigationStateContext.Provider>
  );
}

export function useSessionNavigationState() {
  return useContext(SessionNavigationStateContext);
}

export function useSessionDraft(sessionId: string) {
  const navigationState = useSessionNavigationState();
  const [draft, setDraftState] = useState(
    () => navigationState?.getDraft(sessionId) ?? '',
  );
  const setDraft = useCallback(
    (nextDraft: string) => {
      setDraftState(nextDraft);
      navigationState?.setDraft(sessionId, nextDraft);
    },
    [navigationState, sessionId],
  );

  return { draft, setDraft };
}

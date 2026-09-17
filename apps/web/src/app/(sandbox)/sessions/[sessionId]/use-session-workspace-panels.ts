'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useSessionNavigationState } from '@/hooks/useSessionNavigationState';
import { parseSessionArtifactSearchParams } from '@/lib/artifact-view-urls';
import type { SessionArtifactViewerSelection } from './session-task-panel-context';

export type UtilityWorkspacePanelKind =
  | 'info'
  | 'tasks'
  | 'artifacts'
  | 'previews';

export type UtilityWorkspacePanel =
  | { kind: Exclude<UtilityWorkspacePanelKind, 'artifacts'> }
  | {
      kind: 'artifacts';
      artifact: SessionArtifactViewerSelection | null;
    };

export type TaskArtifactSelection = { path: string; version?: number };

export type SessionWorkspacePanelState = {
  utilityPanel: UtilityWorkspacePanel | null;
  taskPanelIds: string[];
  explicitTaskPanelIds: string[];
  taskArtifacts: Record<string, TaskArtifactSelection>;
  promptFocusTaskId: string | null;
};

export type SessionWorkspacePanelAction =
  | {
      type: 'seed-wide-panels';
      taskIds: string[];
      selectedTaskId: string | null;
    }
  | {
      type: 'add-tasks';
      taskIds: string[];
      selectedTaskId: string | null;
      capacity: number;
    }
  | {
      type: 'promote-running-tasks';
      runningTaskIds: string[];
      transitionedTaskIds: string[];
      selectedTaskId: string | null;
      capacity: number;
    }
  | {
      type: 'open-task';
      taskId: string;
      selectedTaskId: string | null;
      capacity: number;
    }
  | { type: 'open-tasks-utility' }
  | {
      type: 'open-tasks-side-by-side';
      taskIds: string[];
      selectedTaskId: string | null;
    }
  | { type: 'show-main' }
  | {
      type: 'open-session-artifact';
      artifact: SessionArtifactViewerSelection;
    }
  | { type: 'toggle-utility'; kind: UtilityWorkspacePanelKind }
  | { type: 'close-utility' }
  | { type: 'back-to-session-artifacts' }
  | {
      type: 'open-task-artifact';
      taskId: string;
      artifact: TaskArtifactSelection;
    }
  | { type: 'back-to-task'; taskId: string }
  | {
      type: 'close-task';
      taskId: string;
      selectedTaskId: string | null;
    }
  | {
      type: 'select-panel-task';
      currentTaskId: string;
      nextTaskId: string;
      selectedTaskId: string | null;
    }
  | { type: 'focus-complete'; taskId: string };

const SESSION_MAIN_MIN_WIDTH = 400;
const SESSION_TASK_PANEL_MIN_WIDTH = 400;

function withoutTaskArtifact(
  artifacts: Record<string, TaskArtifactSelection>,
  taskId: string,
) {
  if (!artifacts[taskId]) return artifacts;
  const next = { ...artifacts };
  delete next[taskId];
  return next;
}

function withoutTaskArtifacts(
  artifacts: Record<string, TaskArtifactSelection>,
  taskIds: string[],
) {
  let next = artifacts;
  for (const taskId of taskIds) next = withoutTaskArtifact(next, taskId);
  return next;
}

export function createSessionWorkspacePanelState({
  hasRequestedArtifact = false,
  selectedTaskId = null,
}: {
  hasRequestedArtifact?: boolean;
  selectedTaskId?: string | null;
} = {}): SessionWorkspacePanelState {
  return {
    utilityPanel: hasRequestedArtifact
      ? { kind: 'artifacts', artifact: null }
      : null,
    taskPanelIds: [],
    explicitTaskPanelIds: [],
    taskArtifacts: {},
    promptFocusTaskId: selectedTaskId,
  };
}

export function sessionWorkspacePanelReducer(
  state: SessionWorkspacePanelState,
  action: SessionWorkspacePanelAction,
): SessionWorkspacePanelState {
  switch (action.type) {
    case 'seed-wide-panels': {
      const taskPanelIds = [...state.taskPanelIds];
      for (const taskId of action.taskIds) {
        if (
          taskId !== action.selectedTaskId &&
          !taskPanelIds.includes(taskId)
        ) {
          taskPanelIds.push(taskId);
        }
      }
      return {
        ...state,
        taskPanelIds,
      };
    }
    case 'add-tasks': {
      const taskPanelIds = [...state.taskPanelIds];
      const selectedOffset = action.selectedTaskId ? 1 : 0;
      let insertionIndex = Math.max(0, action.capacity - selectedOffset - 1);
      for (const taskId of action.taskIds) {
        if (taskId === action.selectedTaskId || taskPanelIds.includes(taskId)) {
          continue;
        }
        taskPanelIds.splice(
          Math.min(taskPanelIds.length, insertionIndex),
          0,
          taskId,
        );
        insertionIndex += 1;
      }
      const shouldShowTaskPanels =
        state.utilityPanel === null || state.utilityPanel.kind === 'tasks';
      return {
        ...state,
        utilityPanel: shouldShowTaskPanels ? null : state.utilityPanel,
        taskPanelIds,
      };
    }
    case 'promote-running-tasks': {
      const runningTaskIdSet = new Set(action.runningTaskIds);
      const explicitTaskPanelIdSet = new Set(state.explicitTaskPanelIds);
      const visibleSlotCount = Math.max(
        0,
        action.capacity - (action.selectedTaskId ? 1 : 0),
      );
      const taskPanelIds = [...state.taskPanelIds];
      let changed = false;

      for (const taskId of action.transitionedTaskIds) {
        let taskIndex = taskPanelIds.indexOf(taskId);
        if (taskIndex < 0) {
          taskPanelIds.push(taskId);
          taskIndex = taskPanelIds.length - 1;
          changed = true;
        }
        if (
          taskId === action.selectedTaskId ||
          taskIndex < visibleSlotCount ||
          explicitTaskPanelIdSet.has(taskId)
        ) {
          continue;
        }

        let replacementIndex = -1;
        for (let index = visibleSlotCount - 1; index >= 0; index -= 1) {
          const visibleTaskId = taskPanelIds[index];
          if (
            visibleTaskId &&
            !runningTaskIdSet.has(visibleTaskId) &&
            !explicitTaskPanelIdSet.has(visibleTaskId)
          ) {
            replacementIndex = index;
            break;
          }
        }
        if (replacementIndex < 0) continue;

        taskPanelIds.splice(taskIndex, 1);
        const replacedTaskId = taskPanelIds[replacementIndex]!;
        taskPanelIds[replacementIndex] = taskId;
        taskPanelIds.splice(visibleSlotCount, 0, replacedTaskId);
        changed = true;
      }

      return changed ? { ...state, taskPanelIds } : state;
    }
    case 'open-task': {
      const taskArtifacts = withoutTaskArtifact(
        state.taskArtifacts,
        action.taskId,
      );
      if (
        action.taskId === action.selectedTaskId ||
        (action.selectedTaskId && action.capacity === 1)
      ) {
        return {
          ...state,
          utilityPanel: null,
          explicitTaskPanelIds: [
            ...new Set([...state.explicitTaskPanelIds, action.taskId]),
          ],
          taskArtifacts,
          promptFocusTaskId: action.taskId,
        };
      }

      const taskPanelIds = state.taskPanelIds.filter(
        (taskId) => taskId !== action.taskId,
      );
      const selectedOffset = action.selectedTaskId ? 1 : 0;
      const rightmostVisibleIndex = Math.max(
        0,
        action.capacity - selectedOffset - 1,
      );
      taskPanelIds.splice(
        Math.min(taskPanelIds.length, rightmostVisibleIndex),
        0,
        action.taskId,
      );
      return {
        ...state,
        utilityPanel: null,
        taskPanelIds,
        explicitTaskPanelIds: [
          ...new Set([...state.explicitTaskPanelIds, action.taskId]),
        ],
        taskArtifacts,
        promptFocusTaskId: action.taskId,
      };
    }
    case 'open-tasks-utility':
      return { ...state, utilityPanel: { kind: 'tasks' } };
    case 'open-tasks-side-by-side':
      return {
        ...state,
        utilityPanel: null,
        taskPanelIds: action.taskIds.filter(
          (taskId) => taskId !== action.selectedTaskId,
        ),
        explicitTaskPanelIds: [...action.taskIds],
        taskArtifacts: {},
      };
    case 'show-main':
      return {
        utilityPanel: null,
        taskPanelIds: [],
        explicitTaskPanelIds: [],
        taskArtifacts: {},
        promptFocusTaskId: null,
      };
    case 'open-session-artifact':
      return {
        ...state,
        utilityPanel: {
          kind: 'artifacts',
          artifact: action.artifact,
        },
      };
    case 'toggle-utility':
      return {
        ...state,
        utilityPanel:
          state.utilityPanel?.kind === action.kind
            ? null
            : action.kind === 'artifacts'
              ? { kind: 'artifacts', artifact: null }
              : { kind: action.kind },
      };
    case 'close-utility':
      return { ...state, utilityPanel: null };
    case 'back-to-session-artifacts':
      return {
        ...state,
        utilityPanel: { kind: 'artifacts', artifact: null },
      };
    case 'open-task-artifact':
      return {
        ...state,
        taskArtifacts: {
          ...state.taskArtifacts,
          [action.taskId]: action.artifact,
        },
      };
    case 'back-to-task':
      return {
        ...state,
        taskArtifacts: withoutTaskArtifact(state.taskArtifacts, action.taskId),
      };
    case 'close-task':
      return {
        ...state,
        taskPanelIds:
          action.taskId === action.selectedTaskId
            ? state.taskPanelIds
            : state.taskPanelIds.filter((taskId) => taskId !== action.taskId),
        explicitTaskPanelIds: state.explicitTaskPanelIds.filter(
          (taskId) => taskId !== action.taskId,
        ),
        taskArtifacts: withoutTaskArtifact(state.taskArtifacts, action.taskId),
      };
    case 'select-panel-task': {
      if (action.currentTaskId === action.nextTaskId) return state;

      const taskArtifacts = withoutTaskArtifacts(state.taskArtifacts, [
        action.currentTaskId,
        action.nextTaskId,
      ]);
      const explicitTaskPanelIds = [
        ...new Set([
          ...state.explicitTaskPanelIds,
          action.currentTaskId,
          action.nextTaskId,
        ]),
      ];
      if (action.currentTaskId === action.selectedTaskId) {
        const nextIndex = state.taskPanelIds.indexOf(action.nextTaskId);
        if (nextIndex < 0) return { ...state, taskArtifacts };
        return {
          ...state,
          taskPanelIds: state.taskPanelIds.map((taskId, index) =>
            index === nextIndex ? action.currentTaskId : taskId,
          ),
          explicitTaskPanelIds,
          taskArtifacts,
        };
      }
      if (action.nextTaskId === action.selectedTaskId) {
        return {
          ...state,
          taskPanelIds: state.taskPanelIds.map((taskId) =>
            taskId === action.currentTaskId ? action.selectedTaskId! : taskId,
          ),
          explicitTaskPanelIds,
          taskArtifacts,
        };
      }

      const currentIndex = state.taskPanelIds.indexOf(action.currentTaskId);
      if (currentIndex < 0) return { ...state, taskArtifacts };
      const nextIndex = state.taskPanelIds.indexOf(action.nextTaskId);
      const taskPanelIds = [...state.taskPanelIds];
      taskPanelIds[currentIndex] = action.nextTaskId;
      if (nextIndex >= 0) taskPanelIds[nextIndex] = action.currentTaskId;
      return {
        ...state,
        taskPanelIds,
        explicitTaskPanelIds,
        taskArtifacts,
      };
    }
    case 'focus-complete':
      return state.promptFocusTaskId === action.taskId
        ? { ...state, promptFocusTaskId: null }
        : state;
  }
}

export function getSessionTaskPanelCapacity(
  workspaceWidth: number,
  isMdOrLarger: boolean,
) {
  if (!isMdOrLarger || workspaceWidth <= 0) return 1;
  return Math.max(
    1,
    Math.floor(
      (workspaceWidth - SESSION_MAIN_MIN_WIDTH) / SESSION_TASK_PANEL_MIN_WIDTH,
    ),
  );
}

export function getSessionPanelMinSizes(workspaceWidth: number) {
  if (!workspaceWidth) return {};
  return {
    panelMinSize: Math.min(
      40,
      (SESSION_TASK_PANEL_MIN_WIDTH / workspaceWidth) * 100,
    ),
    mainMinSize: Math.min(60, (SESSION_MAIN_MIN_WIDTH / workspaceWidth) * 100),
  };
}

export function getOrderedSessionTaskPanelIds(
  state: SessionWorkspacePanelState,
  selectedTaskId: string | null,
) {
  return [
    ...(selectedTaskId ? [selectedTaskId] : []),
    ...state.taskPanelIds.filter((taskId) => taskId !== selectedTaskId),
  ];
}

export function getVisibleSessionTaskPanelIds(
  state: SessionWorkspacePanelState,
  selectedTaskId: string | null,
  capacity: number,
) {
  return state.utilityPanel
    ? []
    : getOrderedSessionTaskPanelIds(state, selectedTaskId).slice(0, capacity);
}

type SessionWorkspacePanelControllerOptions = {
  sessionId: string;
  taskIds: string[];
  automaticTaskPanelIds: string[];
  runningTaskIds: string[];
  singleRunningTaskId: string | null;
  taskPanelCapacity: number;
  isMdOrLarger: boolean;
  workspaceWidth: number;
};

export function useSessionWorkspacePanels({
  sessionId,
  taskIds,
  automaticTaskPanelIds,
  runningTaskIds,
  singleRunningTaskId,
  taskPanelCapacity,
  isMdOrLarger,
  workspaceWidth,
}: SessionWorkspacePanelControllerOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigationState = useSessionNavigationState();
  const selectedTaskId = searchParams.get('task');
  const selectedPanelTaskId =
    selectedTaskId && taskIds.includes(selectedTaskId) ? selectedTaskId : null;
  const requestedArtifact = selectedTaskId
    ? null
    : parseSessionArtifactSearchParams(searchParams);
  const [state, dispatch] = useReducer(
    sessionWorkspacePanelReducer,
    {
      hasRequestedArtifact: Boolean(requestedArtifact),
      selectedTaskId,
    },
    createSessionWorkspacePanelState,
  );
  const knownTaskIdsRef = useRef<string[] | null>(null);
  const runningTaskIdsRef = useRef<string[] | null>(null);
  const widePanelsSeededRef = useRef(false);

  useEffect(() => {
    if (selectedPanelTaskId) {
      navigationState?.setTaskPanelDismissed(
        sessionId,
        selectedPanelTaskId,
        false,
      );
    }
  }, [navigationState, selectedPanelTaskId, sessionId]);

  const replaceSearchParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      update(params);
      const query = params.toString();
      if (query === searchParams.toString()) return;
      router.replace(`/sessions/${sessionId}${query ? `?${query}` : ''}`);
    },
    [router, searchParams, sessionId],
  );
  const clearRequestedArtifact = useCallback(
    () =>
      replaceSearchParams((params) => {
        params.delete('artifact');
        params.delete('v');
      }),
    [replaceSearchParams],
  );
  const selectTask = useCallback(
    (taskId: string | null) =>
      replaceSearchParams((params) => {
        if (taskId) params.set('task', taskId);
        else params.delete('task');
        params.delete('artifact');
        params.delete('v');
      }),
    [replaceSearchParams],
  );

  useEffect(() => {
    if (!isMdOrLarger || workspaceWidth <= 0) return;

    const dismissedTaskPanelIds =
      navigationState?.getDismissedTaskPanelIds(sessionId);
    const previousTaskIds = knownTaskIdsRef.current;
    const previousRunningTaskIds = runningTaskIdsRef.current;
    knownTaskIdsRef.current = taskIds;
    runningTaskIdsRef.current = runningTaskIds;
    if (!widePanelsSeededRef.current && taskPanelCapacity >= 2) {
      widePanelsSeededRef.current = true;
      dispatch({
        type: 'seed-wide-panels',
        taskIds: dismissedTaskPanelIds
          ? automaticTaskPanelIds.filter(
              (taskId) => !dismissedTaskPanelIds.has(taskId),
            )
          : automaticTaskPanelIds,
        selectedTaskId: selectedPanelTaskId,
      });
      return;
    }
    if (!previousTaskIds || !previousRunningTaskIds) return;

    const previousTaskIdSet = new Set(previousTaskIds);
    const previousRunningTaskIdSet = new Set(previousRunningTaskIds);
    const newTaskIds = automaticTaskPanelIds.filter(
      (taskId) =>
        !previousTaskIdSet.has(taskId) && !dismissedTaskPanelIds?.has(taskId),
    );
    if (newTaskIds.length > 0) {
      dispatch({
        type: 'add-tasks',
        taskIds: newTaskIds,
        selectedTaskId: selectedPanelTaskId,
        capacity: taskPanelCapacity,
      });
    }
    if (widePanelsSeededRef.current) {
      const transitionedTaskIds = runningTaskIds.filter(
        (taskId) =>
          previousTaskIdSet.has(taskId) &&
          !previousRunningTaskIdSet.has(taskId) &&
          !dismissedTaskPanelIds?.has(taskId),
      );
      if (transitionedTaskIds.length > 0) {
        dispatch({
          type: 'promote-running-tasks',
          runningTaskIds,
          transitionedTaskIds,
          selectedTaskId: selectedPanelTaskId,
          capacity: taskPanelCapacity,
        });
      }
    }
  }, [
    isMdOrLarger,
    automaticTaskPanelIds,
    navigationState,
    runningTaskIds,
    selectedPanelTaskId,
    sessionId,
    taskIds,
    taskPanelCapacity,
    workspaceWidth,
  ]);

  const openTaskPanel = useCallback(
    (taskId: string) => {
      navigationState?.setTaskPanelDismissed(sessionId, taskId, false);
      dispatch({
        type: 'open-task',
        taskId,
        selectedTaskId: selectedPanelTaskId,
        capacity: taskPanelCapacity,
      });
      if (
        taskId !== selectedPanelTaskId &&
        selectedPanelTaskId &&
        taskPanelCapacity === 1
      ) {
        selectTask(taskId);
      }
    },
    [
      navigationState,
      selectedPanelTaskId,
      selectTask,
      sessionId,
      taskPanelCapacity,
    ],
  );
  const openTasksPanel = useCallback(() => {
    if (singleRunningTaskId) {
      dispatch({ type: 'close-utility' });
      selectTask(singleRunningTaskId);
      return;
    }
    dispatch({ type: 'open-tasks-utility' });
  }, [selectTask, singleRunningTaskId]);
  const openTasksSideBySide = useCallback(() => {
    for (const taskId of taskIds) {
      navigationState?.setTaskPanelDismissed(sessionId, taskId, false);
    }
    dispatch({
      type: 'open-tasks-side-by-side',
      taskIds,
      selectedTaskId: selectedPanelTaskId,
    });
  }, [navigationState, selectedPanelTaskId, sessionId, taskIds]);
  const showMain = useCallback(() => {
    dispatch({ type: 'show-main' });
    selectTask(null);
  }, [selectTask]);
  const openArtifactViewer = useCallback(
    (artifact: SessionArtifactViewerSelection) => {
      dispatch({ type: 'open-session-artifact', artifact });
      selectTask(null);
    },
    [selectTask],
  );
  const togglePanel = useCallback((kind: UtilityWorkspacePanelKind) => {
    dispatch({ type: 'toggle-utility', kind });
  }, []);
  const closeUtilityPanel = useCallback(() => {
    dispatch({ type: 'close-utility' });
  }, []);
  const closeSessionArtifact = useCallback(() => {
    dispatch({ type: 'close-utility' });
    clearRequestedArtifact();
  }, [clearRequestedArtifact]);
  const backToSessionArtifacts = useCallback(() => {
    dispatch({ type: 'back-to-session-artifacts' });
  }, []);
  const closeTaskPanel = useCallback(
    (taskId: string) => {
      navigationState?.setTaskPanelDismissed(sessionId, taskId, true);
      dispatch({
        type: 'close-task',
        taskId,
        selectedTaskId: selectedPanelTaskId,
      });
      if (taskId === selectedPanelTaskId) selectTask(null);
    },
    [navigationState, selectedPanelTaskId, selectTask, sessionId],
  );
  const selectPanelTask = useCallback(
    (currentTaskId: string, nextTaskId: string) => {
      if (currentTaskId === nextTaskId) return;
      navigationState?.setTaskPanelDismissed(sessionId, nextTaskId, false);
      dispatch({
        type: 'select-panel-task',
        currentTaskId,
        nextTaskId,
        selectedTaskId: selectedPanelTaskId,
      });
      if (currentTaskId === selectedPanelTaskId) selectTask(nextTaskId);
      else if (nextTaskId === selectedPanelTaskId) selectTask(currentTaskId);
    },
    [navigationState, selectedPanelTaskId, selectTask, sessionId],
  );
  const openTaskArtifact = useCallback(
    (taskId: string, path: string, version?: number) =>
      dispatch({
        type: 'open-task-artifact',
        taskId,
        artifact: { path, version },
      }),
    [],
  );
  const backToTask = useCallback((taskId: string) => {
    dispatch({ type: 'back-to-task', taskId });
  }, []);
  const clearPromptFocus = useCallback((taskId: string) => {
    dispatch({ type: 'focus-complete', taskId });
  }, []);

  const visibleTaskPanelIds = getVisibleSessionTaskPanelIds(
    state,
    selectedPanelTaskId,
    taskPanelCapacity,
  );

  return {
    utilityPanel: state.utilityPanel,
    taskArtifacts: state.taskArtifacts,
    promptFocusTaskId: state.promptFocusTaskId,
    requestedArtifact,
    visibleTaskPanelIds,
    panelOpen: state.utilityPanel !== null || visibleTaskPanelIds.length > 0,
    openTaskPanel,
    openTasksPanel,
    openTasksSideBySide,
    showMain,
    openArtifactViewer,
    togglePanel,
    closeUtilityPanel,
    closeSessionArtifact,
    backToSessionArtifacts,
    clearRequestedArtifact,
    closeTaskPanel,
    selectPanelTask,
    openTaskArtifact,
    backToTask,
    clearPromptFocus,
  };
}

'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

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
        promptFocusTaskId:
          action.selectedTaskId ??
          action.taskIds.find((taskId) => taskId !== action.selectedTaskId) ??
          null,
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
      const shouldFocus =
        state.utilityPanel === null || state.utilityPanel.kind === 'tasks';
      return {
        ...state,
        utilityPanel: shouldFocus ? null : state.utilityPanel,
        taskPanelIds,
        promptFocusTaskId: shouldFocus
          ? (action.taskIds[0] ?? state.promptFocusTaskId)
          : state.promptFocusTaskId,
      };
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
        taskArtifacts: {},
        promptFocusTaskId: action.selectedTaskId ?? action.taskIds[0] ?? null,
      };
    case 'show-main':
      return {
        utilityPanel: null,
        taskPanelIds: [],
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
        taskArtifacts: withoutTaskArtifact(state.taskArtifacts, action.taskId),
      };
    case 'select-panel-task': {
      if (action.currentTaskId === action.nextTaskId) return state;

      const taskArtifacts = withoutTaskArtifacts(state.taskArtifacts, [
        action.currentTaskId,
        action.nextTaskId,
      ]);
      if (action.currentTaskId === action.selectedTaskId) {
        const nextIndex = state.taskPanelIds.indexOf(action.nextTaskId);
        if (nextIndex < 0) return { ...state, taskArtifacts };
        return {
          ...state,
          taskPanelIds: state.taskPanelIds.map((taskId, index) =>
            index === nextIndex ? action.currentTaskId : taskId,
          ),
          taskArtifacts,
        };
      }
      if (action.nextTaskId === action.selectedTaskId) {
        return {
          ...state,
          taskPanelIds: state.taskPanelIds.map((taskId) =>
            taskId === action.currentTaskId ? action.selectedTaskId! : taskId,
          ),
          taskArtifacts,
        };
      }

      const currentIndex = state.taskPanelIds.indexOf(action.currentTaskId);
      if (currentIndex < 0) return { ...state, taskArtifacts };
      const nextIndex = state.taskPanelIds.indexOf(action.nextTaskId);
      const taskPanelIds = [...state.taskPanelIds];
      taskPanelIds[currentIndex] = action.nextTaskId;
      if (nextIndex >= 0) taskPanelIds[nextIndex] = action.currentTaskId;
      return { ...state, taskPanelIds, taskArtifacts };
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
  singleRunningTaskId: string | null;
  taskPanelCapacity: number;
  isMdOrLarger: boolean;
  workspaceWidth: number;
};

export function useSessionWorkspacePanels({
  sessionId,
  taskIds,
  singleRunningTaskId,
  taskPanelCapacity,
  isMdOrLarger,
  workspaceWidth,
}: SessionWorkspacePanelControllerOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const widePanelsSeededRef = useRef(false);

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

    const previousTaskIds = knownTaskIdsRef.current;
    knownTaskIdsRef.current = taskIds;
    if (!widePanelsSeededRef.current && taskPanelCapacity >= 2) {
      widePanelsSeededRef.current = true;
      dispatch({
        type: 'seed-wide-panels',
        taskIds,
        selectedTaskId: selectedPanelTaskId,
      });
      return;
    }
    if (!previousTaskIds) return;

    const previousTaskIdSet = new Set(previousTaskIds);
    const newTaskIds = taskIds.filter(
      (taskId) => !previousTaskIdSet.has(taskId),
    );
    if (newTaskIds.length === 0) return;
    dispatch({
      type: 'add-tasks',
      taskIds: newTaskIds,
      selectedTaskId: selectedPanelTaskId,
      capacity: taskPanelCapacity,
    });
  }, [
    isMdOrLarger,
    selectedPanelTaskId,
    taskIds,
    taskPanelCapacity,
    workspaceWidth,
  ]);

  const openTaskPanel = useCallback(
    (taskId: string) => {
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
    [selectedPanelTaskId, selectTask, taskPanelCapacity],
  );
  const openTasksPanel = useCallback(() => {
    if (singleRunningTaskId) {
      dispatch({ type: 'close-utility' });
      selectTask(singleRunningTaskId);
      return;
    }
    dispatch({ type: 'open-tasks-utility' });
  }, [selectTask, singleRunningTaskId]);
  const openTasksSideBySide = useCallback(
    () =>
      dispatch({
        type: 'open-tasks-side-by-side',
        taskIds,
        selectedTaskId: selectedPanelTaskId,
      }),
    [selectedPanelTaskId, taskIds],
  );
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
      dispatch({
        type: 'close-task',
        taskId,
        selectedTaskId: selectedPanelTaskId,
      });
      if (taskId === selectedPanelTaskId) selectTask(null);
    },
    [selectedPanelTaskId, selectTask],
  );
  const selectPanelTask = useCallback(
    (currentTaskId: string, nextTaskId: string) => {
      if (currentTaskId === nextTaskId) return;
      dispatch({
        type: 'select-panel-task',
        currentTaskId,
        nextTaskId,
        selectedTaskId: selectedPanelTaskId,
      });
      if (currentTaskId === selectedPanelTaskId) selectTask(nextTaskId);
      else if (nextTaskId === selectedPanelTaskId) selectTask(currentTaskId);
    },
    [selectedPanelTaskId, selectTask],
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

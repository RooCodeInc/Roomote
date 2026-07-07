'use client';

import { create } from 'zustand';

import type { TaskStatusEvent } from '@roomote/types';

type LiveTaskStatus = {
  phase: TaskStatusEvent['phase'];
  lastErrorMessage: TaskStatusEvent['lastErrorMessage'];
};

type LiveTaskStatusState = {
  statusesByTaskId: Record<string, LiveTaskStatus | undefined>;
  setTaskStatus: (taskId: string, status: TaskStatusEvent | null) => void;
  clearTaskStatus: (taskId: string) => void;
};

const useLiveTaskStatusStore = create<LiveTaskStatusState>((set) => ({
  statusesByTaskId: {},
  setTaskStatus: (taskId, status) => {
    set((state) => {
      const nextStatuses = { ...state.statusesByTaskId };

      if (!status) {
        delete nextStatuses[taskId];
      } else {
        nextStatuses[taskId] = {
          phase: status.phase,
          lastErrorMessage: status.lastErrorMessage,
        };
      }

      return { statusesByTaskId: nextStatuses };
    });
  },
  clearTaskStatus: (taskId) => {
    set((state) => {
      if (!state.statusesByTaskId[taskId]) {
        return state;
      }

      const nextStatuses = { ...state.statusesByTaskId };
      delete nextStatuses[taskId];

      return { statusesByTaskId: nextStatuses };
    });
  },
}));

export function useLiveTaskStatus(taskId: string | null | undefined) {
  return useLiveTaskStatusStore((state) =>
    taskId ? (state.statusesByTaskId[taskId] ?? null) : null,
  );
}

export function setLiveTaskStatus(taskId: string, status: TaskStatusEvent) {
  useLiveTaskStatusStore.getState().setTaskStatus(taskId, status);
}

export function clearLiveTaskStatus(taskId: string) {
  useLiveTaskStatusStore.getState().clearTaskStatus(taskId);
}

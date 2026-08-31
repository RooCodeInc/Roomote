'use client';

import { createContext, useContext } from 'react';

export const OpenSessionTaskPanelContext = createContext<
  ((taskId: string) => void) | null
>(null);
export const SessionRunningTaskCountContext = createContext(0);

export function useOpenSessionTaskPanel() {
  return useContext(OpenSessionTaskPanelContext);
}

export function useSessionRunningTaskCount() {
  return useContext(SessionRunningTaskCountContext);
}

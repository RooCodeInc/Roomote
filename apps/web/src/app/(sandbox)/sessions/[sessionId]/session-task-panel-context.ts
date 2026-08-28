'use client';

import { createContext, useContext } from 'react';

export const OpenSessionTaskPanelContext = createContext<
  ((taskId: string) => void) | null
>(null);

export function useOpenSessionTaskPanel() {
  return useContext(OpenSessionTaskPanelContext);
}

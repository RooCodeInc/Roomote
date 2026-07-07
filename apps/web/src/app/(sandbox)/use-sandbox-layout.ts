'use client';

import { createContext, useContext } from 'react';

interface SandboxLayoutContextValue {
  isSidebarVisible: boolean;
  setSidebarVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
}

export const SandboxLayoutContext =
  createContext<SandboxLayoutContextValue | null>(null);

export function useSandboxLayout() {
  const ctx = useContext(SandboxLayoutContext);

  if (!ctx) {
    throw new Error(
      'useSandboxLayout must be used within SandboxLayoutContext',
    );
  }

  return ctx;
}

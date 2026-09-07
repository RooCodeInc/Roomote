'use client';

import { createContext, useContext, useLayoutEffect } from 'react';

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

export function useResponsiveSandboxSidebar(scopeKey: string) {
  const { setSidebarVisible } = useSandboxLayout();

  useLayoutEffect(() => {
    const mobileQuery = window.matchMedia?.('(max-width: 767px)');

    if (!mobileQuery) {
      return;
    }

    setSidebarVisible(!mobileQuery.matches);

    const handleViewportChange = (event: MediaQueryListEvent) =>
      setSidebarVisible(!event.matches);

    mobileQuery.addEventListener('change', handleViewportChange);

    return () => {
      mobileQuery.removeEventListener('change', handleViewportChange);
      setSidebarVisible(true);
    };
  }, [scopeKey, setSidebarVisible]);
}

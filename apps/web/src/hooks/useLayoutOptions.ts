'use client';

import { useEffect, useLayoutEffect } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const LAYOUT_PERSISTENCE_KEY = 'roomote-layout-options';

type LayoutState = {
  isHeaderVisible: boolean;
  isHeaderSticky: boolean;
  isSideNavExpanded: boolean;
  hasHydrated: boolean;
};

type LayoutActions = {
  setHeaderVisible: (visible: boolean) => void;
  setHeaderSticky: (sticky: boolean) => void;
  setSideNavExpanded: (expanded: boolean) => void;
  setHasHydrated: (hydrated: boolean) => void;
};

export const useLayoutStore = create<LayoutState & LayoutActions>()(
  persist(
    (set) => ({
      isHeaderVisible: true,
      isHeaderSticky: true,
      isSideNavExpanded: false,
      hasHydrated: false,

      setHeaderVisible: (visible) => set({ isHeaderVisible: visible }),
      setHeaderSticky: (sticky) => set({ isHeaderSticky: sticky }),
      setSideNavExpanded: (expanded) => set({ isSideNavExpanded: expanded }),
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
    }),
    {
      name: LAYOUT_PERSISTENCE_KEY,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        isSideNavExpanded: state.isSideNavExpanded,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

interface LayoutOptions {
  header?: { visible?: boolean; sticky?: boolean };
}

export function useHydrateLayoutStore() {
  const hasHydrated = useLayoutStore((state) => state.hasHydrated);

  useLayoutEffect(() => {
    if (hasHydrated) {
      return;
    }

    void useLayoutStore.persist.rehydrate();
  }, [hasHydrated]);
}

export function useLayoutOptions(options: LayoutOptions) {
  const { setHeaderVisible, setHeaderSticky } = useLayoutStore();

  const headerVisible = options.header?.visible;
  const headerSticky = options.header?.sticky;

  useEffect(() => {
    // Apply options.
    if (headerVisible !== undefined) {
      setHeaderVisible(headerVisible);
    }

    if (headerSticky !== undefined) {
      setHeaderSticky(headerSticky);
    }

    // Restore defaults on unmount.
    return () => {
      if (headerVisible !== undefined) {
        setHeaderVisible(true);
      }

      if (headerSticky !== undefined) {
        setHeaderSticky(true);
      }
    };
  }, [headerVisible, headerSticky, setHeaderVisible, setHeaderSticky]);
}

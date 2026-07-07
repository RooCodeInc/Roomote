// pnpm --filter @roomote/web test src/hooks/__tests__/useLayoutOptions.test.ts

import { renderHook, act } from '@testing-library/react';

import {
  useHydrateLayoutStore,
  useLayoutStore,
  useLayoutOptions,
} from '../useLayoutOptions';

describe('useLayoutStore', () => {
  beforeEach(() => {
    localStorage.clear();

    act(() => {
      useLayoutStore.setState({
        isHeaderVisible: true,
        isHeaderSticky: true,
        isSideNavExpanded: false,
        hasHydrated: false,
      });
    });
  });

  describe('initial state', () => {
    it('should have header visible by default', () => {
      const { result } = renderHook(() => useLayoutStore());

      expect(result.current.isHeaderVisible).toBe(true);
    });

    it('should have header sticky by default', () => {
      const { result } = renderHook(() => useLayoutStore());

      expect(result.current.isHeaderSticky).toBe(true);
    });

    it('should have side nav collapsed by default', () => {
      const { result } = renderHook(() => useLayoutStore());

      expect(result.current.isSideNavExpanded).toBe(false);
    });
  });

  describe('setHeaderVisible', () => {
    it('should set header visibility to false', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setHeaderVisible(false);
      });

      expect(result.current.isHeaderVisible).toBe(false);
    });

    it('should set header visibility to true', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setHeaderVisible(false);
      });

      act(() => {
        result.current.setHeaderVisible(true);
      });

      expect(result.current.isHeaderVisible).toBe(true);
    });
  });

  describe('setHeaderSticky', () => {
    it('should set header sticky to false', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setHeaderSticky(false);
      });

      expect(result.current.isHeaderSticky).toBe(false);
    });

    it('should set header sticky to true', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setHeaderSticky(false);
      });

      act(() => {
        result.current.setHeaderSticky(true);
      });

      expect(result.current.isHeaderSticky).toBe(true);
    });
  });

  describe('setSideNavExpanded', () => {
    it('should set side nav expansion to true', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setSideNavExpanded(true);
      });

      expect(result.current.isSideNavExpanded).toBe(true);
    });

    it('should persist side nav expansion to localStorage', () => {
      const { result } = renderHook(() => useLayoutStore());

      act(() => {
        result.current.setSideNavExpanded(true);
      });

      expect(
        JSON.parse(localStorage.getItem('roomote-layout-options') ?? 'null'),
      ).toEqual({
        state: {
          isSideNavExpanded: true,
        },
        version: 0,
      });
    });

    it('should rehydrate side nav expansion from localStorage', async () => {
      localStorage.setItem(
        'roomote-layout-options',
        JSON.stringify({
          state: {
            isSideNavExpanded: true,
          },
          version: 0,
        }),
      );

      await act(async () => {
        await useLayoutStore.persist.rehydrate();
      });

      expect(useLayoutStore.getState().isSideNavExpanded).toBe(true);
    });

    it('should defer persisted side nav expansion until explicit hydration', () => {
      localStorage.setItem(
        'roomote-layout-options',
        JSON.stringify({
          state: {
            isSideNavExpanded: true,
          },
          version: 0,
        }),
      );

      const { result } = renderHook(() => useLayoutStore());

      expect(result.current.isSideNavExpanded).toBe(false);
      expect(result.current.hasHydrated).toBe(false);
    });

    it('should rehydrate persisted side nav expansion in the hydration hook', async () => {
      localStorage.setItem(
        'roomote-layout-options',
        JSON.stringify({
          state: {
            isSideNavExpanded: true,
          },
          version: 0,
        }),
      );

      renderHook(() => useHydrateLayoutStore());

      await act(async () => {
        await Promise.resolve();
      });

      expect(useLayoutStore.getState().isSideNavExpanded).toBe(true);
      expect(useLayoutStore.getState().hasHydrated).toBe(true);
    });
  });
});

describe('useLayoutOptions', () => {
  beforeEach(() => {
    localStorage.clear();

    act(() => {
      useLayoutStore.setState({
        isHeaderVisible: true,
        isHeaderSticky: true,
        isSideNavExpanded: false,
        hasHydrated: false,
      });
    });
  });

  describe('applying options', () => {
    it('should apply header.visible option', () => {
      renderHook(() => useLayoutOptions({ header: { visible: false } }));

      expect(useLayoutStore.getState().isHeaderVisible).toBe(false);
    });

    it('should apply header.sticky option', () => {
      renderHook(() => useLayoutOptions({ header: { sticky: false } }));

      expect(useLayoutStore.getState().isHeaderSticky).toBe(false);
    });

    it('should apply multiple options at once', () => {
      renderHook(() =>
        useLayoutOptions({
          header: { visible: false, sticky: false },
        }),
      );

      const state = useLayoutStore.getState();

      expect(state.isHeaderVisible).toBe(false);
      expect(state.isHeaderSticky).toBe(false);
    });

    it('should not change undefined options', () => {
      renderHook(() => useLayoutOptions({ header: { visible: false } }));

      const state = useLayoutStore.getState();

      expect(state.isHeaderVisible).toBe(false);
      expect(state.isHeaderSticky).toBe(true); // unchanged
    });

    it('should handle empty options object', () => {
      renderHook(() => useLayoutOptions({}));

      const state = useLayoutStore.getState();

      expect(state.isHeaderVisible).toBe(true);
      expect(state.isHeaderSticky).toBe(true);
    });
  });

  describe('cleanup on unmount', () => {
    it('should restore header.visible to default on unmount', () => {
      const { unmount } = renderHook(() =>
        useLayoutOptions({ header: { visible: false } }),
      );

      expect(useLayoutStore.getState().isHeaderVisible).toBe(false);

      unmount();

      expect(useLayoutStore.getState().isHeaderVisible).toBe(true);
    });

    it('should restore header.sticky to default on unmount', () => {
      const { unmount } = renderHook(() =>
        useLayoutOptions({ header: { sticky: false } }),
      );

      expect(useLayoutStore.getState().isHeaderSticky).toBe(false);

      unmount();

      expect(useLayoutStore.getState().isHeaderSticky).toBe(true);
    });

    it('should restore all options to defaults on unmount', () => {
      const { unmount } = renderHook(() =>
        useLayoutOptions({
          header: { visible: false, sticky: false },
        }),
      );

      const beforeUnmount = useLayoutStore.getState();

      expect(beforeUnmount.isHeaderVisible).toBe(false);
      expect(beforeUnmount.isHeaderSticky).toBe(false);

      unmount();

      const afterUnmount = useLayoutStore.getState();

      expect(afterUnmount.isHeaderVisible).toBe(true);
      expect(afterUnmount.isHeaderSticky).toBe(true);
    });

    it('should not restore options that were not set', () => {
      // First, change the default values.
      act(() => {
        useLayoutStore.setState({
          isHeaderVisible: false,
          isHeaderSticky: false,
          isSideNavExpanded: true,
          hasHydrated: true,
        });
      });

      // Only set header.visible.
      const { unmount } = renderHook(() =>
        useLayoutOptions({ header: { visible: true } }),
      );

      expect(useLayoutStore.getState().isHeaderVisible).toBe(true);

      unmount();

      // Only header.visible should be restored to default (true).
      // Other values should remain unchanged from our manual setState.
      const afterUnmount = useLayoutStore.getState();

      expect(afterUnmount.isHeaderVisible).toBe(true); // restored to default
      expect(afterUnmount.isHeaderSticky).toBe(false); // unchanged (not specified)
      expect(afterUnmount.isSideNavExpanded).toBe(true); // unchanged (persisted state)
    });
  });

  describe('option changes', () => {
    it('should update store when options change', () => {
      const { rerender } = renderHook(
        ({ options }) => useLayoutOptions(options),
        {
          initialProps: { options: { header: { visible: false } } },
        },
      );

      expect(useLayoutStore.getState().isHeaderVisible).toBe(false);

      rerender({ options: { header: { visible: true } } });

      expect(useLayoutStore.getState().isHeaderVisible).toBe(true);
    });
  });
});

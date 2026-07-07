import { act, renderHook } from '@testing-library/react';

import { useCursorPagination } from './usePagination';

describe('useCursorPagination', () => {
  it('clears stale future cursors when the current page no longer has a next cursor', () => {
    const { result } = renderHook(() => useCursorPagination(20));

    act(() => {
      result.current.setNextCursor('cursor-page-2');
    });

    expect(result.current.hasNextPage).toBe(true);

    act(() => {
      result.current.nextPage();
    });

    act(() => {
      result.current.setNextCursor('cursor-page-3');
    });

    expect(result.current.currentPageIndex).toBe(1);
    expect(result.current.currentCursor).toBe('cursor-page-2');
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.cursors[2]).toBe('cursor-page-3');

    act(() => {
      result.current.setNextCursor(undefined);
    });

    expect(result.current.currentPageIndex).toBe(1);
    expect(result.current.currentCursor).toBe('cursor-page-2');
    expect(result.current.cursors[2]).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  });
});

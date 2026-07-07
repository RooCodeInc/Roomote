import { useState, useMemo, useCallback } from 'react';

export type CursorValue = string | number;

export interface CursorPaginationControls {
  pageSize: number;
  cursors: CursorValue[];
  currentPageIndex: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentCursor: CursorValue | undefined;
  nextPage: () => void;
  previousPage: () => void;
  reset: () => void;
  setNextCursor: (cursor: CursorValue | undefined) => void;
  setPageSize: (size: number) => void;
}

export const useCursorPagination = (
  initialPageSize: number = 20,
): CursorPaginationControls => {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [cursors, setCursors] = useState<CursorValue[]>([]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const currentCursor = cursors[currentPageIndex];
  const hasNextPage = currentPageIndex < cursors.length - 1;
  const hasPreviousPage = currentPageIndex > 0;

  const nextPage = useCallback(() => {
    if (hasNextPage) {
      setCurrentPageIndex((prev) => prev + 1);
    }
  }, [hasNextPage]);

  const previousPage = useCallback(() => {
    if (hasPreviousPage) {
      setCurrentPageIndex((prev) => prev - 1);
    }
  }, [hasPreviousPage]);

  const setNextCursor = useCallback(
    (cursor: CursorValue | undefined) => {
      setCursors((prev) => {
        const nextIndex = currentPageIndex + 1;

        if (cursor === undefined) {
          return prev.length > nextIndex ? prev.slice(0, nextIndex) : prev;
        }

        if (prev[nextIndex] !== cursor || prev.length !== nextIndex + 1) {
          const newCursors = [...prev];
          newCursors[nextIndex] = cursor;
          return newCursors.slice(0, nextIndex + 1);
        }

        return prev;
      });
    },
    [currentPageIndex],
  );

  const reset = useCallback(() => {
    setCursors([]);
    setCurrentPageIndex(0);
  }, []);

  const handleSetPageSize = useCallback(
    (size: number) => {
      setPageSize(size);
      reset(); // Reset pagination when page size changes
    },
    [reset],
  );

  return useMemo(
    () => ({
      pageSize,
      cursors,
      currentPageIndex,
      hasNextPage,
      hasPreviousPage,
      currentCursor,
      nextPage,
      previousPage,
      reset,
      setNextCursor,
      setPageSize: handleSetPageSize,
    }),
    [
      pageSize,
      cursors,
      currentPageIndex,
      hasNextPage,
      hasPreviousPage,
      currentCursor,
      nextPage,
      previousPage,
      reset,
      setNextCursor,
      handleSetPageSize,
    ],
  );
};

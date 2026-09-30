'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export function usePromptHistoryNavigation({
  history,
  value,
  onNavigate,
}: {
  history: readonly string[];
  value: string;
  onNavigate: (value: string) => void;
}) {
  const historyIndexRef = useRef<number | null>(null);
  const loadedValueRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resetNavigation = useCallback(() => {
    historyIndexRef.current = null;
    loadedValueRef.current = null;
  }, []);

  useEffect(() => {
    resetNavigation();
  }, [history, resetNavigation]);

  useEffect(() => {
    if (historyIndexRef.current !== null && value !== loadedValueRef.current) {
      resetNavigation();
    }
  }, [resetNavigation, value]);

  useLayoutEffect(() => {
    if (historyIndexRef.current !== null && value === loadedValueRef.current) {
      textareaRef.current?.setSelectionRange(0, 0);
    }
  }, [value]);

  return useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (
        event.key !== 'ArrowUp' ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.nativeEvent.isComposing ||
        event.currentTarget.selectionStart !== 0 ||
        event.currentTarget.selectionEnd !== 0
      ) {
        return false;
      }

      const currentIndex = historyIndexRef.current;
      const nextIndex =
        currentIndex === null ? history.length - 1 : currentIndex - 1;

      if (
        nextIndex < 0 ||
        (currentIndex === null
          ? value !== ''
          : value !== loadedValueRef.current)
      ) {
        return false;
      }

      const nextValue = history[nextIndex];
      if (nextValue === undefined) {
        return false;
      }

      event.preventDefault();
      historyIndexRef.current = nextIndex;
      loadedValueRef.current = nextValue;
      textareaRef.current = event.currentTarget;
      onNavigate(nextValue);
      return true;
    },
    [history, onNavigate, value],
  );
}

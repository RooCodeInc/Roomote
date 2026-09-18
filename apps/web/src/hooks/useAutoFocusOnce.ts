'use client';

import { useEffect, useRef, type RefObject } from 'react';

export function useAutoFocusOnce<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  enabled = true,
) {
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    const element = elementRef.current;
    if (
      !enabled ||
      hasFocusedRef.current ||
      !element ||
      !window.matchMedia('(min-width: 768px)').matches
    ) {
      return;
    }

    element.focus();
    if (document.activeElement === element) {
      hasFocusedRef.current = true;
    }
  }, [elementRef, enabled]);
}

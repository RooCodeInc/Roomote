'use client';

import { useEffect, useRef, type RefObject } from 'react';

export function useAutoFocusOnce<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  enabled = true,
) {
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!enabled || hasFocusedRef.current || !element) return;

    element.focus();
    if (document.activeElement === element) {
      hasFocusedRef.current = true;
    }
  }, [elementRef, enabled]);
}

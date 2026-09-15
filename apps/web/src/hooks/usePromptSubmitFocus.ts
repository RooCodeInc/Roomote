'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

export function usePromptSubmitFocus(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const pendingRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const cancelForOutsideInteraction = (event: Event) => {
      if (!pendingRef.current || !(event.target instanceof Node)) return;

      const form = textareaRef.current?.form;
      if (!form?.contains(event.target)) pendingRef.current = false;
    };

    document.addEventListener('pointerdown', cancelForOutsideInteraction, true);
    document.addEventListener('focusin', cancelForOutsideInteraction, true);

    return () => {
      document.removeEventListener(
        'pointerdown',
        cancelForOutsideInteraction,
        true,
      );
      document.removeEventListener(
        'focusin',
        cancelForOutsideInteraction,
        true,
      );
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [textareaRef]);

  const beginSubmit = useCallback(() => {
    pendingRef.current = true;
  }, []);

  const cancelSubmit = useCallback(() => {
    pendingRef.current = false;
  }, []);

  const restoreFocus = useCallback(() => {
    if (!pendingRef.current) return;

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (!pendingRef.current) return;

      pendingRef.current = false;
      textareaRef.current?.focus();
    });
  }, [textareaRef]);

  return { beginSubmit, cancelSubmit, restoreFocus };
}

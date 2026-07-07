'use client';

import { useEffect, useRef } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

interface HashScrollableMessage {
  ts: number;
}

/**
 * When the URL contains a hash fragment (e.g. #msg-1234567890), scrolls
 * the matching element into view once messages are loaded.
 * Calls `stopScroll` on StickToBottom to prevent it from overriding.
 */
export function ScrollToHash({
  messages,
}: {
  messages: readonly HashScrollableMessage[];
}) {
  const { stopScroll } = useStickToBottomContext();
  const highlightedHashRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    const clearPendingHighlight = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const getHighlightTarget = (anchor: HTMLElement) => {
      if (anchor.classList.contains('chat-message')) {
        return anchor;
      }

      const nestedMessage = anchor.querySelector<HTMLElement>('.chat-message');

      if (nestedMessage) {
        return nestedMessage;
      }

      return anchor.closest<HTMLElement>('.chat-message') ?? anchor;
    };

    const scrollToCurrentHash = () => {
      const hash = window.location.hash.slice(1);

      if (!hash || highlightedHashRef.current === hash) {
        return;
      }

      const anchor = document.getElementById(hash);

      if (!anchor) {
        return;
      }

      stopScroll();
      clearPendingHighlight();

      rafRef.current = requestAnimationFrame(() => {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Delay highlight so the scroll has time to bring the element
        // into the viewport before the visual cue fires.
        timeoutRef.current = setTimeout(() => {
          document
            .querySelector('.permalink-highlight')
            ?.classList.remove('permalink-highlight');

          getHighlightTarget(anchor).classList.add('permalink-highlight');
          highlightedHashRef.current = hash;
        }, 1000);
      });
    };

    const handleHashChange = () => {
      highlightedHashRef.current = null;
      scrollToCurrentHash();
    };

    scrollToCurrentHash();
    window.addEventListener('hashchange', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      clearPendingHighlight();
    };
  }, [messages, stopScroll]);

  return null;
}

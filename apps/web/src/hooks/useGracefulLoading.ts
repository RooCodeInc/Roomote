'use client';

import { useState, useEffect } from 'react';

interface GracefulLoadingOptions {
  isPending: boolean;
  data: unknown;
  dependencies?: unknown[];
}

interface GracefulLoadingReturn {
  showContent: boolean;
  isTransitioning: boolean;
}

/**
 * Custom hook to manage graceful loading transitions that prevent jarring
 * "no data" flashes.
 * Ensures a minimum loading time before showing content and resets state when
 * dependencies change.
 */
export function useGracefulLoading({
  isPending,
  data,
  dependencies = [],
}: GracefulLoadingOptions): GracefulLoadingReturn {
  const [showContent, setShowContent] = useState(false);

  // Prevent flashing by ensuring minimum loading time.
  useEffect(() => {
    let timeoutId: number;

    if (!isPending && data !== undefined) {
      // Add minimum delay before showing content to prevent flash.
      timeoutId = window.setTimeout(() => setShowContent(true), 400);
    } else {
      setShowContent(false);
    }

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isPending, data]);

  // Reset show content when dependencies change (e.g., filters).
  const dependenciesKey = JSON.stringify(dependencies);

  useEffect(() => setShowContent(false), [dependenciesKey]);

  return {
    showContent,
    isTransitioning: !isPending && !showContent,
  };
}

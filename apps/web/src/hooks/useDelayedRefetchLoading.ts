'use client';

import { useEffect, useRef, useState } from 'react';

type UseDelayedRefetchLoadingOptions = {
  loadingKey: string;
  isFetching: boolean;
  isInitialLoading: boolean;
  delayMs?: number;
};

export function useDelayedRefetchLoading({
  loadingKey,
  isFetching,
  isInitialLoading,
  delayMs = 3_000,
}: UseDelayedRefetchLoadingOptions) {
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const hasMountedRef = useRef(false);
  const previousLoadingKeyRef = useRef(loadingKey);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      previousLoadingKeyRef.current = loadingKey;
      return;
    }

    if (previousLoadingKeyRef.current === loadingKey) {
      return;
    }

    previousLoadingKeyRef.current = loadingKey;
    setShowLoading(false);
    setTrackedKey(loadingKey);
  }, [loadingKey]);

  useEffect(() => {
    const isTrackedRefetch =
      trackedKey === loadingKey && isFetching && !isInitialLoading;

    if (!isTrackedRefetch) {
      setShowLoading(false);

      if (!isFetching && trackedKey !== null) {
        setTrackedKey(null);
      }

      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShowLoading(true);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, isFetching, isInitialLoading, loadingKey, trackedKey]);

  return showLoading;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitDiffResponse } from '@roomote/types';

import { useSandboxClient } from './SandboxProvider';

export type { FileDiff, GitDiffResponse, RepoDiff } from '@roomote/types';

export function useDiffView(enabled: boolean) {
  const client = useSandboxClient();
  const [data, setData] = useState<GitDiffResponse>();
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const hasDataRef = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled) {
      return;
    }

    setRefreshVersion((version) => version + 1);
  }, [enabled]);

  // Reset local state when switching sandbox client (different task/session).
  useEffect(() => {
    hasDataRef.current = false;
    setData(undefined);
    setError(null);
    setIsLoading(false);
    setRefreshVersion(0);
  }, [client]);

  useEffect(() => {
    if (!enabled || !client) {
      setIsLoading(false);
      return;
    }

    let receivedData = false;

    setError(null);

    if (!hasDataRef.current) {
      setIsLoading(true);
    }

    const subscription = client.commands.diffOutput.subscribe(undefined, {
      onData: (next) => {
        receivedData = true;
        hasDataRef.current = true;
        setData(next);
        setError(null);
        setIsLoading(false);
      },
      onError: (error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));

        setError(normalized);
        setIsLoading(false);

        console.warn(
          '[useDiffView] diffOutput subscription error:',
          normalized.message,
        );
      },
      onComplete: () => {
        if (!receivedData) {
          setIsLoading(false);
        }
      },
    });

    return () => subscription.unsubscribe();
  }, [enabled, client, refreshVersion]);

  return { data, error, isLoading, refresh };
}

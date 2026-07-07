import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSandboxClient } from './SandboxProvider';

interface PerFileTailState {
  lines: string[];
  active: boolean;
}

interface MultiplexedTailLogs {
  /** Get the current lines for a specific file path. */
  getLines: (filePath: string) => string[];
  /** Whether the multiplexed subscription is active. */
  active: boolean;
  /** Connection error, if any. */
  error: string | null;
  /** Clear lines for a specific file path. */
  clear: (filePath: string) => void;
  /** Clear lines for all file paths. */
  clearAll: () => void;
}

/**
 * Multiplexes multiple tail log streams over a single tRPC subscription using
 * `tailMulti`.
 *
 * The hook subscribes once with all file paths and demuxes incoming tagged
 * chunks into per-file line buffers. When the file list changes the
 * subscription is torn down and recreated.
 */
export function useMultiplexedTailLogs(
  filePaths: string[],
): MultiplexedTailLogs {
  const client = useSandboxClient();

  const [perFile, setPerFile] = useState<Record<string, PerFileTailState>>({});
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-file partial-line buffers (not part of React state since they're
  // internal bookkeeping for line splitting).
  const buffersRef = useRef<Record<string, string>>({});

  // Stable serialized key so the effect only re-runs when the actual list of
  // paths changes, not on every render.
  const filePathsKey = useMemo(
    () => [...filePaths].sort().join('\0'),
    [filePaths],
  );

  const clear = useCallback((filePath: string) => {
    buffersRef.current[filePath] = '';
    setPerFile((prev) => ({
      ...prev,
      [filePath]: { lines: [], active: prev[filePath]?.active ?? false },
    }));
  }, []);

  const clearAll = useCallback(() => {
    buffersRef.current = {};
    setPerFile((prev) => {
      const next: Record<string, PerFileTailState> = {};

      for (const key of Object.keys(prev)) {
        next[key] = { lines: [], active: prev[key]?.active ?? false };
      }

      return next;
    });
  }, []);

  const getLines = useCallback(
    (filePath: string): string[] => perFile[filePath]?.lines ?? [],
    [perFile],
  );

  useEffect(() => {
    if (!client || filePaths.length === 0) {
      setActive(false);
      return;
    }

    // Reset state for new subscription.
    setError(null);
    buffersRef.current = {};

    const initialState: Record<string, PerFileTailState> = {};

    for (const fp of filePaths) {
      initialState[fp] = { lines: [], active: false };
    }

    setPerFile(initialState);

    const subscription = client.commands.tailMulti.subscribe(
      { filePaths },
      {
        onStarted: () => setActive(true),
        onData: (chunk) => {
          const fp = chunk.filePath;

          if (chunk.type === 'stdout' || chunk.type === 'stderr') {
            if (chunk.data) {
              const prev = buffersRef.current[fp] ?? '';
              const combined = prev + chunk.data;
              const parts = combined.split('\n');
              buffersRef.current[fp] = parts.pop() ?? '';

              if (parts.length > 0) {
                setPerFile((state) => ({
                  ...state,
                  [fp]: {
                    active: state[fp]?.active ?? false,
                    lines: [...(state[fp]?.lines ?? []), ...parts],
                  },
                }));
              }
            }
          } else if (chunk.type === 'exit') {
            const remaining = buffersRef.current[fp] ?? '';
            buffersRef.current[fp] = '';

            setPerFile((state) => ({
              ...state,
              [fp]: {
                lines: remaining
                  ? [...(state[fp]?.lines ?? []), remaining]
                  : (state[fp]?.lines ?? []),
                active: false,
              },
            }));
          }
        },
        onError: (err: unknown) => {
          setActive(false);
          setError(
            err instanceof Error ? err.message : 'Tail connection failed',
          );
        },
        onComplete: () => {
          setActive(false);
        },
      },
    );

    return () => {
      subscription.unsubscribe();
      setActive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filePathsKey is the stable serialization
  }, [client, filePathsKey]);

  return { getLines, active, error, clear, clearAll };
}

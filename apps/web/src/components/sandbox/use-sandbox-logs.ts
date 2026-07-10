'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

import {
  type SandboxLogEntry,
  sandboxLogEventSchema,
  sandboxErrorEventSchema,
} from '@roomote/types';

interface UseSandboxLogsOptions {
  runId: number | undefined;
  enabled?: boolean;
}

interface UseSandboxLogsResult {
  logs: SandboxLogEntry[];
  error: string | null;
  isConnected: boolean;
}

export function useSandboxLogs({
  runId,
  enabled = true,
}: UseSandboxLogsOptions): UseSandboxLogsResult {
  const [logs, setLogs] = useState<SandboxLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (!runId || !enabled) {
      cleanup();
      return;
    }

    const eventSource = new EventSource(`/api/task-runs/${runId}/logs`, {
      withCredentials: true,
    });

    eventSourceRef.current = eventSource;

    eventSource.addEventListener('open', () => {
      setIsConnected(true);
      setError(null);
    });

    eventSource.addEventListener('log', (event) => {
      try {
        const result = sandboxLogEventSchema.safeParse(JSON.parse(event.data));

        if (result.success) {
          const { stream, data } = result.data;
          setLogs((prev) => [...prev, { stream, data, timestamp: Date.now() }]);
        }
      } catch {
        // Ignore malformed log events
      }
    });

    eventSource.addEventListener('error', (event) => {
      // Check if this is a custom error event from our endpoint.
      if (event instanceof MessageEvent && event.data) {
        try {
          const result = sandboxErrorEventSchema.safeParse(
            JSON.parse(event.data),
          );

          if (result.success) {
            setError(result.data.error);
          } else {
            // Connection error, not a custom error event.
            setError('Connection lost');
          }
        } catch {
          // Malformed error event, treat as connection error.
          setError('Connection lost');
        }
      }

      setIsConnected(false);
    });

    eventSource.addEventListener('disconnect', () => cleanup());

    return cleanup;
  }, [runId, enabled, cleanup]);

  return { logs, error, isConnected };
}

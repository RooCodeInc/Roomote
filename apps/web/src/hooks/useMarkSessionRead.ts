'use client';

import { useEffect, useRef } from 'react';

import { useTRPCClient } from '@/trpc/client';

/**
 * Advances the viewer's read cursor for a session on mount and whenever the
 * window regains focus or visibility. The server resolves the latest external
 * event itself, so this costs one tiny mutation instead of a timeline fetch.
 */
export function useMarkSessionRead(sessionId: string) {
  const trpc = useTRPCClient();
  const lastRunAtRef = useRef(0);

  useEffect(() => {
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      // Returning to a tab fires focus AND visibilitychange back-to-back;
      // one mutation is enough.
      const now = Date.now();
      if (now - lastRunAtRef.current < 1_000) return;
      lastRunAtRef.current = now;
      void trpc.sessions.markRead.mutate({ sessionId });
    };
    markRead();
    window.addEventListener('focus', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [sessionId, trpc]);
}

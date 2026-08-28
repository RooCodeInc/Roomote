'use client';

import { useEffect } from 'react';

import { useTRPCClient } from '@/trpc/client';

/**
 * Advances the viewer's read cursor for a session on mount and whenever the
 * window regains focus or visibility. The server resolves the latest external
 * event itself, so this costs one tiny mutation instead of a timeline fetch.
 */
export function useMarkSessionRead(sessionId: string) {
  const trpc = useTRPCClient();

  useEffect(() => {
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
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

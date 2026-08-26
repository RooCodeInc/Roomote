'use client';

import { useEffect } from 'react';

import { useRecentSessions } from '@/hooks/useRecentSessions';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useTRPCClient } from '@/trpc/client';

export function SessionReadTracker({ sessionId }: { sessionId: string }) {
  const trpc = useTRPCClient();
  const { recordVisit } = useRecentSessions();
  const { capture } = useTelemetry();

  useEffect(() => {
    recordVisit(sessionId);
    capture('session_opened', { surface: 'web', outcome: 'opened' });
    const markRead = async () => {
      if (document.visibilityState !== 'visible') return;
      const timeline = await trpc.sessions.timeline.query({ sessionId });
      const last = timeline?.events.findLast((event) => !event.own);
      if (!last) return;
      await trpc.sessions.markRead.mutate({
        sessionId,
        throughEventAt: last.at,
        throughEventId: last.id,
      });
    };
    void markRead();
    window.addEventListener('focus', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [capture, recordVisit, sessionId, trpc]);

  return null;
}

'use client';

import { useEffect } from 'react';

import { useTRPCClient } from '@/trpc/client';

export function TaskSessionReadTracker({ sessionId }: { sessionId: string }) {
  const trpc = useTRPCClient();

  useEffect(() => {
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
    return () => window.removeEventListener('focus', markRead);
  }, [sessionId, trpc]);

  return null;
}

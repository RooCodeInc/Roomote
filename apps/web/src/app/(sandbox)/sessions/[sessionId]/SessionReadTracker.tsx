'use client';

import { useEffect } from 'react';

import { useMarkSessionRead } from '@/hooks/useMarkSessionRead';
import { useRecentSessions } from '@/hooks/useRecentSessions';
import { useTelemetry } from '@/hooks/useTelemetry';

export function SessionReadTracker({ sessionId }: { sessionId: string }) {
  const { recordVisit } = useRecentSessions();
  const { capture } = useTelemetry();

  useMarkSessionRead(sessionId);

  useEffect(() => {
    recordVisit(sessionId);
    capture('session_opened', { surface: 'web', outcome: 'opened' });
  }, [capture, recordVisit, sessionId]);

  return null;
}

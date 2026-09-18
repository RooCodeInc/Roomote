'use client';

import { useEffect, useState } from 'react';

import { useMarkSessionRead } from '@/hooks/useMarkSessionRead';
import { useRecentSessions } from '@/hooks/useRecentSessions';
import { useSessionPresence } from '@/hooks/useSessionPresence';
import { useSessionBrowserAttention } from '@/hooks/useSessionBrowserAttention';
import { useTelemetry } from '@/hooks/useTelemetry';
import { getPendingFastSessionLaunch } from '@/lib/pending-fast-session-launch';

export function SessionReadTracker({ sessionId }: { sessionId: string }) {
  const { recordVisit } = useRecentSessions();
  const { capture } = useTelemetry();
  const [presenceClientId] = useState(
    () => getPendingFastSessionLaunch(sessionId)?.presenceClientId,
  );

  useMarkSessionRead(sessionId);
  useSessionPresence(sessionId, presenceClientId);
  const { prompt } = useSessionBrowserAttention(sessionId);

  useEffect(() => {
    recordVisit(sessionId);
    capture('session_opened', { surface: 'web', outcome: 'opened' });
  }, [capture, recordVisit, sessionId]);

  return prompt;
}

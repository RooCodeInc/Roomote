'use client';

import { useMarkSessionRead } from '@/hooks/useMarkSessionRead';
import { useSessionBrowserAttention } from '@/hooks/useSessionBrowserAttention';
import { useSessionPresence } from '@/hooks/useSessionPresence';

export function TaskSessionReadTracker({ sessionId }: { sessionId: string }) {
  useMarkSessionRead(sessionId);
  useSessionPresence(sessionId);
  const { prompt } = useSessionBrowserAttention(sessionId);

  return prompt;
}

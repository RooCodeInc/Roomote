'use client';

import { useMarkSessionRead } from '@/hooks/useMarkSessionRead';

export function TaskSessionReadTracker({ sessionId }: { sessionId: string }) {
  useMarkSessionRead(sessionId);

  return null;
}

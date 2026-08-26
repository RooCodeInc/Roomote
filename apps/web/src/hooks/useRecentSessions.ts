'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuthorizedUser } from './useUser';

const MAX_RECENT_SESSIONS = 20;

export function useRecentSessions() {
  const { userId } = useAuthorizedUser();
  const storageKey = `roomote-recent-sessions:${userId}`;
  const [recentSessionIds, setRecentSessionIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      setRecentSessionIds(Array.isArray(stored) ? stored.slice(0, 20) : []);
    } catch {
      setRecentSessionIds([]);
    }
  }, [storageKey]);

  const recordVisit = useCallback(
    (sessionId: string) => {
      setRecentSessionIds((current) => {
        const next = [
          sessionId,
          ...current.filter((id) => id !== sessionId),
        ].slice(0, MAX_RECENT_SESSIONS);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Local recents are best-effort.
        }
        return next;
      });
    },
    [storageKey],
  );

  return { recentSessionIds, recordVisit };
}

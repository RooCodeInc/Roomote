'use client';

import { useCallback, useMemo } from 'react';
import { useLocalStorage } from 'usehooks-ts';

import { useAuthorizedUser } from './useUser';

const STORAGE_KEY_PREFIX = 'roomote-recent-sessions';
const MAX_RECENT = 20;

type RecentEntry = { id: string; visitedAt: number };

/**
 * Tracks recently visited session IDs in localStorage, mirroring
 * useRecentTasks. Storage is scoped per signed-in user so account switches do
 * not leak history.
 */
export function useRecentSessions() {
  const { userId } = useAuthorizedUser();
  const [entries, setEntries] = useLocalStorage<RecentEntry[]>(
    `${STORAGE_KEY_PREFIX}:${userId}`,
    [],
  );

  const recordVisit = useCallback(
    (sessionId: string) => {
      setEntries((prev) => {
        const filtered = prev.filter((entry) => entry.id !== sessionId);
        return [{ id: sessionId, visitedAt: Date.now() }, ...filtered].slice(
          0,
          MAX_RECENT,
        );
      });
    },
    [setEntries],
  );

  const recentSessionIds = useMemo(
    () => entries.map((entry) => entry.id),
    [entries],
  );

  return { recentSessionIds, recordVisit };
}

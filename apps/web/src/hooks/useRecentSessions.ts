'use client';

import { useCallback, useMemo } from 'react';
import { useLocalStorage } from 'usehooks-ts';

import { useAuthorizedUser } from './useUser';

const STORAGE_KEY_PREFIX = 'roomote-recent-sessions';
const MAX_RECENT = 20;

type RecentEntry = { id: string; visitedAt: number };

// An earlier build stored plain id strings under the same key; normalize so
// legacy entries neither leak undefined ids nor evade the dedupe filter.
function normalizeEntries(stored: unknown): RecentEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry): RecentEntry | null =>
      typeof entry === 'string'
        ? { id: entry, visitedAt: 0 }
        : entry && typeof (entry as RecentEntry).id === 'string'
          ? (entry as RecentEntry)
          : null,
    )
    .filter((entry): entry is RecentEntry => entry !== null);
}

/**
 * Tracks recently visited session IDs in localStorage, mirroring
 * useRecentTasks. Storage is scoped per signed-in user so account switches do
 * not leak history.
 */
export function useRecentSessions() {
  const { userId } = useAuthorizedUser();
  const [storedEntries, setEntries] = useLocalStorage<RecentEntry[]>(
    `${STORAGE_KEY_PREFIX}:${userId}`,
    [],
  );
  const entries = useMemo(
    () => normalizeEntries(storedEntries),
    [storedEntries],
  );

  const recordVisit = useCallback(
    (sessionId: string) => {
      setEntries((prev) => {
        const filtered = normalizeEntries(prev).filter(
          (entry) => entry.id !== sessionId,
        );
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

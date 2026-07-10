import { useCallback, useMemo } from 'react';
import { useLocalStorage } from 'usehooks-ts';

import { useAuthorizedUser } from '@/hooks/useUser';

const STORAGE_KEY_PREFIX = 'roomote-recent-tasks';
const MAX_RECENT = 20;

type RecentEntry = { id: string; visitedAt: number };

/**
 * Hook to track recently visited task IDs in localStorage.
 * Returns the ordered list of recent IDs and a function to record a visit.
 * Storage is scoped per signed-in user so account switches do not leak history.
 */
export function useRecentTasks() {
  const { userId } = useAuthorizedUser();
  const [entries, setEntries] = useLocalStorage<RecentEntry[]>(
    `${STORAGE_KEY_PREFIX}:${userId}`,
    [],
  );

  const recordVisit = useCallback(
    (taskId: string) => {
      setEntries((prev) => {
        const filtered = prev.filter((e) => e.id !== taskId);
        return [{ id: taskId, visitedAt: Date.now() }, ...filtered].slice(
          0,
          MAX_RECENT,
        );
      });
    },
    [setEntries],
  );

  const recentTaskIds = useMemo(() => entries.map((e) => e.id), [entries]);

  return { recentTaskIds, recordVisit };
}

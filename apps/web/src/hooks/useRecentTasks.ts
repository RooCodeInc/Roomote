import { useCallback, useMemo } from 'react';
import { useLocalStorage } from 'usehooks-ts';

const STORAGE_KEY = 'roomote-recent-tasks';
const MAX_RECENT = 20;

type RecentEntry = { id: string; visitedAt: number };

/**
 * Hook to track recently visited task IDs in localStorage.
 * Returns the ordered list of recent IDs and a function to record a visit.
 */
export function useRecentTasks() {
  const [entries, setEntries] = useLocalStorage<RecentEntry[]>(STORAGE_KEY, []);

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

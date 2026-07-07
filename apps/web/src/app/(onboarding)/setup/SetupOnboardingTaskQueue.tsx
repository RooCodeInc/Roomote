'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { QueuedOnboardingTask } from '@/trpc/commands/setup-new/types';

import { Checkbox, ChevronDown } from '@/components/system';
import { useTRPC } from '@/trpc/client';

const TASK_SUGGESTIONS_POLL_INTERVAL_MS = 2_000;

export function SetupOnboardingTaskQueue({
  taskId,
  queuedOnboardingTasks,
  matchingEnvironment: _matchingEnvironment,
}: {
  taskId: string | null;
  queuedOnboardingTasks: QueuedOnboardingTask[];
  matchingEnvironment: { id: string; name: string } | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const suggestionsQuery = useQuery({
    ...trpc.taskSuggestions.list.queryOptions(undefined, {
      enabled: taskId !== null,
    }),
    refetchInterval: (query) =>
      query.state.data?.generationStatus === 'pending'
        ? TASK_SUGGESTIONS_POLL_INTERVAL_MS
        : false,
  });

  const persistedSelection = useMemo(
    () =>
      queuedOnboardingTasks
        .filter(
          (task): task is QueuedOnboardingTask & { suggestionId: string } =>
            task.suggestionId !== null,
        )
        .map((task) => task.suggestionId),
    [queuedOnboardingTasks],
  );

  const persistedSelectionKey = [...persistedSelection].sort().join('|');
  const syncedPersistedSelectionRef = useRef({
    key: persistedSelectionKey,
    value: persistedSelection,
  });
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>(
    () => persistedSelection,
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const debouncedSaveRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<string[] | null>(null);

  if (syncedPersistedSelectionRef.current.key !== persistedSelectionKey) {
    syncedPersistedSelectionRef.current = {
      key: persistedSelectionKey,
      value: persistedSelection,
    };
  }

  useEffect(() => {
    if (debouncedSaveRef.current !== null) {
      window.clearTimeout(debouncedSaveRef.current);
      debouncedSaveRef.current = null;
    }
    pendingSelectionRef.current = null;

    setSelectedSuggestionIds(syncedPersistedSelectionRef.current.value);
  }, [persistedSelectionKey, taskId]);

  const saveQueuedTasks = useMutation(
    trpc.setupNew.saveQueuedTasks.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const { mutate: mutateQueuedTasks } = saveQueuedTasks;

  useEffect(() => {
    return () => {
      if (debouncedSaveRef.current !== null) {
        window.clearTimeout(debouncedSaveRef.current);
        debouncedSaveRef.current = null;
      }

      if (taskId && pendingSelectionRef.current !== null) {
        mutateQueuedTasks({
          selectedSuggestionIds: pendingSelectionRef.current,
          customTaskPrompt: '',
        });
        pendingSelectionRef.current = null;
      }
    };
  }, [mutateQueuedTasks, taskId]);

  if (!taskId) {
    return null;
  }

  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const generationStatus = suggestionsQuery.data?.generationStatus ?? 'idle';

  const saveQueue = ({
    nextSelectedSuggestionIds,
  }: {
    nextSelectedSuggestionIds: string[];
  }) => {
    if (!taskId) {
      return;
    }

    if (debouncedSaveRef.current !== null) {
      window.clearTimeout(debouncedSaveRef.current);
    }

    pendingSelectionRef.current = nextSelectedSuggestionIds;
    debouncedSaveRef.current = window.setTimeout(() => {
      debouncedSaveRef.current = null;
      pendingSelectionRef.current = null;
      mutateQueuedTasks({
        selectedSuggestionIds: nextSelectedSuggestionIds,
        customTaskPrompt: '',
      });
    }, 300);
  };

  const toggleSuggestion = (suggestionId: string, checked: boolean) => {
    setSelectedSuggestionIds((current) => {
      const nextSelectedSuggestionIds = checked
        ? current.includes(suggestionId)
          ? current
          : [...current, suggestionId]
        : current.filter((candidate) => candidate !== suggestionId);

      saveQueue({
        nextSelectedSuggestionIds,
      });

      return nextSelectedSuggestionIds;
    });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-2 rounded-xl bg-card py-2 divide-y">
        {suggestions.map((suggestion) => {
          const checked = selectedSuggestionIds.includes(suggestion.id);
          const expanded = expandedIds.has(suggestion.id);
          const inputId = `suggested-first-task-${suggestion.id}`;

          const toggleExpanded = (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setExpandedIds((current) => {
              const next = new Set(current);
              if (next.has(suggestion.id)) {
                next.delete(suggestion.id);
              } else {
                next.add(suggestion.id);
              }
              return next;
            });
          };

          return (
            <div key={suggestion.id} className="text-sm">
              <label
                htmlFor={inputId}
                className="flex cursor-pointer items-center gap-3 px-4 pt-1 pb-3"
              >
                <Checkbox
                  id={inputId}
                  checked={checked}
                  onCheckedChange={(nextChecked) =>
                    toggleSuggestion(suggestion.id, nextChecked === true)
                  }
                  className="shrink-0"
                />
                <span className="flex-1 font-semibold">{suggestion.title}</span>
                <button
                  type="button"
                  onClick={toggleExpanded}
                  className="shrink-0 cursor-pointer p-0.5 text-muted-foreground transition-colors hover:text-accent-foreground"
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                >
                  <ChevronDown
                    className={`size-4 transition-transform ${expanded && 'rotate-180'}`}
                  />
                </button>
              </label>
              {expanded && suggestion.brief ? (
                <div className="pl-10 pr-7 pb-3 text-sm whitespace-pre-wrap text-muted-foreground">
                  {suggestion.brief}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {generationStatus === 'pending' ? (
        <p className="text-xs text-muted-foreground">
          Generating suggestions for this repository set.
        </p>
      ) : null}

      {generationStatus === 'empty' ? (
        <p className="text-xs text-muted-foreground">
          We couldn&apos;t generate suggestions for this repository set.
        </p>
      ) : null}

      {suggestionsQuery.isError ? (
        <p className="text-xs text-muted-foreground">
          Suggestions are unavailable right now.
        </p>
      ) : null}
    </section>
  );
}

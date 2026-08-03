'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { ALL_REPOSITORIES } from '@roomote/types';

import {
  type Filter,
  type TimePeriodFilter,
  HAS_PULL_REQUEST_FILTER_VALUE,
  parseTimePeriodParam,
} from '@/types';

import { DEFAULT_VISIBLE_TASK_WORKFLOWS, getTaskCategoryById } from '@/lib';
import { cn } from '@/lib/utils';

import { useAuthorizedUser } from '@/hooks/useUser';
import {
  useTasks,
  useTaskPagination,
  useDeleteTasks,
  useTaskFilterState,
} from '@/hooks/tasks';
import { useGracefulLoading } from '@/hooks/useGracefulLoading';

import {
  Trash2,
  AlertTriangle,
  ListChecks,
  X,
  FunnelX,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  CursorPagination,
  Empty,
  EmptyHeader,
  EmptyDescription,
} from '@/components/system';
import {
  TaskFilters,
  TaskCard,
  TaskCardSkeleton,
  TaskCardError,
} from '@/components/tasks';
import {
  parseTaskTypeFilterParam,
  serializeTaskTypeFilterParam,
} from '@/components/tasks/taskTypeFilter';

export const Tasks = () => {
  const { userId, isAdmin } = useAuthorizedUser();
  const showTaskTypeFilter = false;

  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Filters
   */

  const [filterUserId, setFilterUserId] = useState<string | null>(
    searchParams.get('userId'),
  );
  const [category, setCategory] = useState<string | null>(
    searchParams.get('category'),
  );

  const [repositoryName, setRepositoryName] = useState<string | null>(
    searchParams.get('repositoryName'),
  );

  const [pullRequest, setPullRequest] = useState<string | null>(
    searchParams.get('pullRequest'),
  );
  const [model, setModel] = useState<string | null>(searchParams.get('model'));

  const [timePeriod, setTimePeriod] = useState<TimePeriodFilter>(() =>
    parseTimePeriodParam(searchParams.get('timePeriod'), 'all'),
  );
  const hasTaskTypesParam = searchParams.has('taskTypes');
  const taskTypesParam = hasTaskTypesParam
    ? (searchParams.get('taskTypes') ?? '')
    : null;
  const selectedTaskTypes = useMemo(
    () =>
      showTaskTypeFilter
        ? hasTaskTypesParam
          ? (parseTaskTypeFilterParam(taskTypesParam ?? '') ?? [
              ...DEFAULT_VISIBLE_TASK_WORKFLOWS,
            ])
          : [...DEFAULT_VISIBLE_TASK_WORKFLOWS]
        : [...DEFAULT_VISIBLE_TASK_WORKFLOWS],
    [hasTaskTypesParam, showTaskTypeFilter, taskTypesParam],
  );

  // Update filters when URL changes (for navigation from other pages).
  const searchParamsString = searchParams.toString();
  const selectedCategory = useMemo(
    () => getTaskCategoryById(category),
    [category],
  );
  const defaultsToAnyUser =
    isAdmin || (selectedCategory?.isAutonomous ?? false);
  const effectiveFilterUserId =
    filterUserId ?? (defaultsToAnyUser ? 'all' : null);

  useEffect(() => {
    const userParam = searchParams.get('userId');
    const categoryParam = searchParams.get('category');
    const repoParam = searchParams.get('repositoryName');
    const prParam = searchParams.get('pullRequest');
    const modelParam = searchParams.get('model');
    const periodParam = searchParams.get('timePeriod');

    const newUserId = userParam || null;
    const newCategory = categoryParam || null;
    const newRepositoryName = repoParam || null;
    const newPullRequest = prParam || null;
    const newModel = modelParam || null;
    const newTimePeriod = parseTimePeriodParam(periodParam, 'all');

    // Always update state based on URL (URL is source of truth).
    setFilterUserId(newUserId);
    setCategory(newCategory);
    setRepositoryName(newRepositoryName);
    setPullRequest(newPullRequest);
    setModel(newModel);
    setTimePeriod(newTimePeriod);
  }, [searchParams, searchParamsString]);

  const handleUserChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value === null) {
      // "Any User" selected → explicit opt-out via 'all'.
      params.set('userId', 'all');
    } else if (value === userId && !defaultsToAnyUser) {
      // Current user selected → remove param to use server default.
      params.delete('userId');
    } else {
      params.set('userId', value);
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handleRepositoryChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set('repositoryName', value);
    } else {
      params.delete('repositoryName');
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handlePullRequestChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set('pullRequest', value);
    } else {
      params.delete('pullRequest');
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handleModelChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set('model', value);
    } else {
      params.delete('model');
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handleTimePeriodChange = (value: TimePeriodFilter) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value !== 'all') {
      params.set('timePeriod', value.toString());
    } else {
      params.delete('timePeriod');
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handleTaskTypesChange = (taskTypes: typeof selectedTaskTypes) => {
    const params = new URLSearchParams(searchParams.toString());
    const nextTaskTypesParam = serializeTaskTypeFilterParam(taskTypes);

    if (nextTaskTypesParam === null) {
      params.delete('taskTypes');
    } else {
      params.set('taskTypes', nextTaskTypesParam);
    }

    router.replace(
      params.toString() ? `?${params.toString()}` : window.location.pathname,
      { scroll: false },
    );
  };

  const handleClearAllFilters = () =>
    router.replace(`${window.location.pathname}?userId=all`, {
      scroll: false,
    });

  // Build filters array based on state.
  const effectiveFilters = useMemo(() => {
    const result: Filter[] = [];
    if (selectedCategory) {
      result.push({
        type: 'category',
        value: selectedCategory.id,
        label: selectedCategory.label,
      });
    }

    // Keep an explicit 'all' sentinel so the backend can distinguish it from
    // "no user filter provided" (which defaults to current user).
    if (effectiveFilterUserId === 'all') {
      result.push({ type: 'userId', value: 'all', label: 'all' });
    } else {
      // In /tasks, omitting the URL param means "current user".
      const effectiveUserId = effectiveFilterUserId ?? userId;

      if (effectiveUserId) {
        result.push({
          type: 'userId',
          value: effectiveUserId,
          label: effectiveUserId,
        });
      }
    }

    // Add repository or environment filter.
    if (repositoryName) {
      if (repositoryName.startsWith('env:')) {
        result.push({
          type: 'environmentId',
          value: repositoryName.slice(4),
          label: repositoryName,
        });
      } else {
        result.push({
          type: 'repositoryName',
          value: repositoryName,
          label: repositoryName,
        });
      }
    }

    // Add pull request filter.
    if (pullRequest) {
      const pullRequestLabel =
        pullRequest === HAS_PULL_REQUEST_FILTER_VALUE
          ? 'Has PR'
          : pullRequest.replace(ALL_REPOSITORIES, 'All Repositories');

      result.push({
        type: 'pullRequest',
        value: pullRequest,
        label: pullRequestLabel,
      });
    }

    if (model) {
      result.push({
        type: 'model',
        value: model,
        label: model,
      });
    }

    if (showTaskTypeFilter && hasTaskTypesParam) {
      if (selectedTaskTypes.length === 0) {
        result.push({ type: 'taskType', value: '', label: '' });
      } else {
        result.push(
          ...selectedTaskTypes.map((taskType) => ({
            type: 'taskType' as const,
            value: taskType,
            label: taskType,
          })),
        );
      }
    }

    return result;
  }, [
    effectiveFilterUserId,
    hasTaskTypesParam,
    model,
    pullRequest,
    repositoryName,
    selectedCategory,
    selectedTaskTypes,
    showTaskTypeFilter,
    userId,
  ]);

  const taskFilterState = useTaskFilterState(effectiveFilters, {
    defaultUserId: defaultsToAnyUser ? null : userId,
    includeImplicitDefaultUserFilter: !defaultsToAnyUser,
  });

  /**
   * Tasks (Graceful Loading + Polling + Pagination)
   */

  const { data, isPending, isError, pagination } = useTasks({
    filters: effectiveFilters,
    timePeriod,
  });

  const tasks = data?.tasks || [];

  useTaskPagination(pagination, effectiveFilters, timePeriod, data?.nextCursor);

  const { showContent } = useGracefulLoading({
    isPending,
    data: tasks,
    dependencies: [effectiveFilters, timePeriod],
  });

  const tasksListRef = useRef<HTMLDivElement>(null);

  /**
   * Task Deletion
   */

  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const deleteTasksMutation = useDeleteTasks({
    onSuccess: (result) => {
      toast.success(
        `Deleted ${result.deletedCount} task${result.deletedCount === 1 ? '' : 's'}.`,
      );

      setSelectedTasks(new Set());
      setIsSelectionMode(false); // Exit selection mode after successful deletion.
    },
    onError: () => {
      toast.error('Failed to delete tasks.');
    },
  });

  const handleSelectionChange = (id: string, selected: boolean) => {
    setSelectedTasks((prev) => {
      const newSet = new Set(prev);

      if (selected) {
        newSet.add(id);
      } else {
        newSet.delete(id);
      }

      return newSet;
    });
  };

  const handleSelectAll = (checked: boolean | 'indeterminate') => {
    // We only handle boolean values, not indeterminate state.
    if (typeof checked === 'boolean') {
      if (checked) {
        // Deletion is deployment-wide: any member can delete any task.
        setSelectedTasks(new Set(tasks.map((t) => t.id)));
      } else {
        setSelectedTasks(new Set());
      }
    }
  };

  const handleBulkDelete = () => {
    if (selectedTasks.size === 0) {
      return;
    }

    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    try {
      await deleteTasksMutation.mutateAsync({
        taskIds: Array.from(selectedTasks),
      });

      setShowDeleteDialog(false);
    } catch {
      // Error is already handled by onError in the mutation.
      // Just close the dialog on error.
      setShowDeleteDialog(false);
    }
  };

  const toggleSelectionMode = () => {
    if (isSelectionMode) {
      // Exiting selection mode - clear selections.
      setSelectedTasks(new Set());
    }

    setIsSelectionMode(!isSelectionMode);
  };

  // Preserve only selections that still exist in the current task list when
  // tasks change.
  useEffect(() => {
    if (data?.tasks && data.tasks.length > 0 && selectedTasks.size > 0) {
      setSelectedTasks((prev) => {
        const taskIds = new Set(data.tasks.map((t) => t.id));
        return new Set([...prev].filter((id) => taskIds.has(id)));
      });
    }
  }, [data?.tasks, selectedTasks.size]);

  /**
   * Derived State
   */

  const hasSelections = selectedTasks.size > 0;
  const isLoading = isPending || !showContent;

  const isFiltering =
    taskFilterState.hasNonDefaultFilters || timePeriod !== 'all';
  const hasAppliedFilters =
    effectiveFilters.some(
      (filter) => filter.type !== 'userId' || filter.value !== 'all',
    ) || timePeriod !== 'all';

  const canSelect = tasks.length > 0 && !isSelectionMode && !isLoading;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="bg-background border-b-4 border-b-card p-4">
        <div className="flex items-center justify-between bg-b">
          <TaskFilters
            userId={effectiveFilterUserId}
            defaultUserId={defaultsToAnyUser ? undefined : userId}
            category={selectedCategory?.id ?? null}
            repositoryName={repositoryName}
            pullRequest={pullRequest}
            model={model}
            taskTypes={selectedTaskTypes}
            timePeriod={timePeriod}
            onUserChange={handleUserChange}
            onRepositoryChange={handleRepositoryChange}
            onPullRequestChange={handlePullRequestChange}
            onModelChange={handleModelChange}
            onTaskTypesChange={handleTaskTypesChange}
            onTimePeriodChange={handleTimePeriodChange}
            showTaskType={showTaskTypeFilter}
          />

          <div className="flex items-center justify-between gap-2">
            {!isSelectionMode ? (
              <>
                {isFiltering && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearAllFilters}
                    className="size-8"
                    title="Clear all filters"
                  >
                    <FunnelX className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canSelect}
                  onClick={toggleSelectionMode}
                  className={cn('size-8', isSelectionMode && 'opacity-0')}
                  title={
                    isSelectionMode
                      ? 'Exit selection mode'
                      : 'Enter selection mode'
                  }
                >
                  <ListChecks className="size-4" />
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="select-all-tasks"
                    checked={
                      selectedTasks.size === tasks.length && tasks.length > 0
                    }
                    onCheckedChange={handleSelectAll}
                    className="cursor-pointer"
                    aria-label="Select all tasks"
                  />
                  <Label
                    htmlFor="select-all-tasks"
                    className="text-xs cursor-pointer text-muted-foreground"
                  >
                    All
                  </Label>
                </div>
                <Button
                  variant="ghost"
                  className="text-red-700"
                  size="xs"
                  aria-label="Delete selected tasks"
                  onClick={handleBulkDelete}
                  disabled={!hasSelections || deleteTasksMutation.isPending}
                >
                  <Trash2 className="size-4" />
                  Delete ({selectedTasks.size})
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  aria-label="Exit selection mode"
                  onClick={toggleSelectionMode}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content area: loading, error, or tasks */}
      {isLoading ? (
        <div className="flex min-h-0 flex-1 bg-background">
          <TaskCardSkeleton />
        </div>
      ) : isError ? (
        <div className="flex min-h-0 flex-1 bg-background">
          <TaskCardError />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex min-h-0 flex-1 bg-background">
          <Empty>
            <EmptyHeader>
              {hasAppliedFilters ? (
                <>
                  <EmptyDescription className="text-sm">
                    No tasks match your criteria.
                  </EmptyDescription>
                  <EmptyDescription className="text-sm">
                    <Link
                      href="/tasks?userId=all"
                      className="font-semibold hover:underline"
                    >
                      Remove the filters
                    </Link>{' '}
                    to show all tasks.
                  </EmptyDescription>
                </>
              ) : (
                <EmptyDescription className="text-sm">
                  <>
                    No tasks yet!{' '}
                    <Link href="/" className="font-bold hover:underline">
                      Run your first task
                    </Link>
                    {' and it will appear here.'}
                  </>
                </EmptyDescription>
              )}
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          {/* Delete Confirmation Dialog */}
          <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-5 text-destructive" />
                  Confirm Deletion
                </DialogTitle>
                <DialogDescription>
                  {selectedTasks.size === 1
                    ? 'Are you sure you want to delete this task? This action cannot be undone.'
                    : `Are you sure you want to delete ${selectedTasks.size} tasks? This action cannot be undone.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowDeleteDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleConfirmDelete}
                  disabled={deleteTasksMutation.isPending}
                >
                  {deleteTasksMutation.isPending
                    ? 'Deleting...'
                    : `Delete (${selectedTasks.size})`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <div
              ref={tasksListRef}
              className="min-h-0 flex-1 divide-y divide-card overflow-y-auto overflow-x-hidden"
            >
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  filterState={taskFilterState}
                  isSelected={selectedTasks.has(task.id)}
                  inSelectionMode={isSelectionMode}
                  onSelectionChange={
                    isSelectionMode ? handleSelectionChange : undefined
                  }
                />
              ))}

              <CursorPagination
                pagination={pagination}
                scrollTargetRef={tasksListRef}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

'use client';

import {
  Fragment,
  startTransition,
  useEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMediaQuery } from 'usehooks-ts';

import {
  Button,
  CircleAlert,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  RetryableLoadError,
  Skeleton,
  TriangleAlert,
  X,
} from '@/components/system';
import { MessageResponse } from '@/components/ai-elements';
import { PullRequestBadge } from '@/components/sandbox';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';
import { TaskAutomationIcon } from '@/components/tasks/TaskAutomationIcon';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useTRPC } from '@/trpc/client';
import type { ResultInboxItem } from '@/trpc/commands/results';

import { ResponsiveWorkspacePanels } from '../../(sandbox)/SandboxWorkspacePanels';

const EMPTY_RESULTS: ResultInboxItem[] = [];
const DETAIL_SKELETON_DELAY_MS = 500;
const EMPTY_RESULT_ID = '00000000-0000-4000-8000-000000000000';

function resultKey(result: Pick<ResultInboxItem, 'id' | 'kind'>) {
  return `${result.kind}:${result.id}`;
}

function AutomationAvatar({
  result,
  size = 'default',
}: {
  result: ResultInboxItem;
  size?: 'default' | 'large';
}) {
  const isLarge = size === 'large';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-clip rounded-full border border-border bg-white ring-1 ring-card dark:bg-muted',
        isLarge ? 'size-8' : 'size-7',
      )}
    >
      <TaskAutomationIcon
        automationKey={result.automationKey}
        className={isLarge ? 'size-6' : 'size-5'}
      />
    </span>
  );
}

function PriorityMarker({
  result,
  selected,
}: {
  result: ResultInboxItem;
  selected: boolean;
}) {
  if (result.priority === 'normal') return null;
  const Icon = result.priority === 'critical' ? TriangleAlert : CircleAlert;
  return (
    <Icon
      aria-label={`${result.priority === 'critical' ? 'Critical' : 'High'} priority`}
      className={cn(
        'size-3 shrink-0',
        selected
          ? 'text-black'
          : result.priority === 'critical'
            ? 'text-destructive'
            : 'text-warning',
      )}
      strokeWidth={2}
    />
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid min-h-[34rem] grid-cols-1 overflow-hidden bg-background md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="space-y-1 bg-background p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="hidden space-y-4 bg-background p-8 md:block">
        <Skeleton className="h-8 w-3/5" />
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4 px-5 py-6 md:px-8 md:py-8">
      <Skeleton className="h-7 w-3/5" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="mt-8 h-44 w-full" />
    </div>
  );
}

export function ResultsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { capture } = useTelemetry();
  const isDesktop = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  const requestedResultKey = searchParams.get('result') ?? '';
  const [selectedKey, setSelectedKey] = useState(requestedResultKey);
  const previousResultParamRef = useRef(requestedResultKey);
  const [showSuggestionComposer, setShowSuggestionComposer] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [displayedResult, setDisplayedResult] =
    useState<ResultInboxItem | null>(null);
  const [showDetailSkeleton, setShowDetailSkeleton] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const resultListRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const mainActionRef = useRef<HTMLAnchorElement | HTMLButtonElement>(null);
  const trackedInboxViewRef = useRef(false);
  const [canScrollResultsUp, setCanScrollResultsUp] = useState(false);
  const [canScrollResultsDown, setCanScrollResultsDown] = useState(false);
  const replaceResultParam = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key) params.set('result', key);
    else params.delete('result');
    const href = params.size > 0 ? `/results?${params.toString()}` : '/results';
    startTransition(() => router.replace(href));
  };
  const listQueryKey = trpc.results.list.queryKey();
  const listQuery = useQuery(trpc.results.list.queryOptions(undefined));

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listQueryKey }),
      queryClient.invalidateQueries({
        queryKey: trpc.results.pendingCount.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.results.unreadCount.queryKey(),
      }),
    ]);
  };
  const clearMutation = useMutation(
    trpc.results.clearOne.mutationOptions({
      onMutate: async (variables) => {
        await queryClient.cancelQueries({ queryKey: listQueryKey });
        const previous =
          queryClient.getQueryData<ResultInboxItem[]>(listQueryKey);
        queryClient.setQueryData<ResultInboxItem[]>(listQueryKey, (results) =>
          results?.filter(
            (result) =>
              result.id !== variables.id || result.kind !== variables.kind,
          ),
        );
        return { previous };
      },
      onError: (error, _variables, context) => {
        queryClient.setQueryData(listQueryKey, context?.previous);
        toast.error(error.message);
      },
      onSuccess: (result) => {
        if (result.success) toast.success('Result cleared');
      },
      onSettled: () => void invalidate(),
    }),
  );
  const clearAllMutation = useMutation(
    trpc.results.clear.mutationOptions({
      onSuccess: (result) => {
        capture('results_cleared_all', { count: result.clearedCount });
        setSelectedKey('');
        setDisplayedResult(null);
        replaceResultParam('');
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const acceptSuggestionMutation = useMutation(
    trpc.results.acceptSuggestion.mutationOptions({
      onSuccess: () => void invalidate(),
      onError: (error) => toast.error(error.message),
    }),
  );

  useEffect(() => {
    if (previousResultParamRef.current === requestedResultKey) return;
    previousResultParamRef.current = requestedResultKey;
    setSelectedKey(requestedResultKey);
    setShowSuggestionComposer(false);
  }, [requestedResultKey]);

  const results = listQuery.data ?? EMPTY_RESULTS;
  const selectedSummary =
    results.find((result) => resultKey(result) === selectedKey) ?? null;
  const updateResultScrollBoundaries = () => {
    const list = resultListRef.current;
    if (!list) return;
    setCanScrollResultsUp(list.scrollTop > 1);
    setCanScrollResultsDown(
      list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    );
  };
  const detailQuery = useQuery(
    trpc.results.get.queryOptions(
      {
        id: selectedSummary?.id ?? EMPTY_RESULT_ID,
        kind: selectedSummary?.kind ?? 'report',
      },
      { enabled: selectedSummary !== null },
    ),
  );
  const displayedKey = displayedResult ? resultKey(displayedResult) : '';
  const isDetailTransition =
    selectedSummary !== null && displayedKey !== selectedKey;
  const actionableResult = isDetailTransition ? null : displayedResult;

  useEffect(() => {
    const list = resultListRef.current;
    if (!list) return;
    updateResultScrollBoundaries();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateResultScrollBoundaries);
    observer.observe(list);
    return () => observer.disconnect();
  }, [results.length]);

  useEffect(() => {
    if (!trackedInboxViewRef.current && listQuery.isSuccess) {
      trackedInboxViewRef.current = true;
      capture('results_inbox_viewed', { count: results.length });
    }
  }, [capture, listQuery.isSuccess, results.length]);

  useEffect(() => {
    if (!selectedSummary || displayedKey === selectedKey) {
      setShowDetailSkeleton(false);
      return;
    }

    setShowDetailSkeleton(false);
    const timeout = window.setTimeout(
      () => setShowDetailSkeleton(true),
      DETAIL_SKELETON_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [displayedKey, selectedKey, selectedSummary]);

  useEffect(() => {
    const next = detailQuery.data;
    if (next && resultKey(next) === selectedKey) {
      setDisplayedResult(next);
      setShowDetailSkeleton(false);
      return;
    }
    // A rejected detail fetch falls back to the already-loaded list item so
    // the pane never stays on a skeleton or goes blank; recovery retries the
    // list query, which re-populates the detail cache.
    if (detailQuery.isError && selectedSummary) {
      setDisplayedResult(selectedSummary);
      setShowDetailSkeleton(false);
    }
  }, [detailQuery.data, detailQuery.isError, selectedKey, selectedSummary]);

  const closeResultDetail = () => {
    const prior = selectedKey;
    setSelectedKey('');
    setShowSuggestionComposer(false);
    setDisplayedResult(null);
    setShowDetailSkeleton(false);
    replaceResultParam('');
    requestAnimationFrame(() => rowRefs.current.get(prior)?.focus());
  };

  const selectResult = (result: ResultInboxItem) => {
    const key = resultKey(result);
    setSelectedKey(key);
    setShowSuggestionComposer(false);
    capture('result_selected', {
      kind: result.kind,
      priority: result.priority,
      preparation: result.preparationStatus,
    });
    replaceResultParam(key);
    if (!isDesktop) {
      requestAnimationFrame(() => detailHeadingRef.current?.focus());
    }
  };

  const clearResult = (result: ResultInboxItem) => {
    if (resultKey(result) !== selectedKey) return;
    const index = results.findIndex(
      (candidate) => resultKey(candidate) === resultKey(result),
    );
    const next = results[index + 1] ?? results[index - 1] ?? null;
    const nextKey = next ? resultKey(next) : '';
    setSelectedKey(nextKey);
    setShowSuggestionComposer(false);
    if (!next) setDisplayedResult(null);
    replaceResultParam(nextKey);
    capture('result_cleared', { kind: result.kind, priority: result.priority });
    clearMutation.mutate({ id: result.id, kind: result.kind });
  };

  useEffect(() => {
    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const target = event.target;
      const element = target instanceof Element ? target : null;
      const editable = Boolean(
        element?.closest('input, textarea, select, [contenteditable="true"]'),
      );
      if (editable) return;

      const ordinaryControl = element?.closest(
        'a, button:not([data-result-select]), [role="button"]',
      );
      if (ordinaryControl) return;

      const selectedIndex = results.findIndex(
        (result) => resultKey(result) === selectedKey,
      );
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const nextIndex =
          selectedIndex === -1
            ? event.key === 'ArrowDown'
              ? 0
              : results.length - 1
            : selectedIndex + (event.key === 'ArrowDown' ? 1 : -1);
        const next = results[nextIndex];
        if (!next) return;
        event.preventDefault();
        selectResult(next);
        if (isDesktop) {
          requestAnimationFrame(() =>
            rowRefs.current.get(resultKey(next))?.focus(),
          );
        }
        return;
      }

      if (event.repeat || !selectedSummary) return;
      if (event.key === 'Delete') {
        event.preventDefault();
        clearResult(selectedSummary);
      } else if (
        (event.key === 'Enter' || event.key === 'Return') &&
        actionableResult &&
        mainActionRef.current
      ) {
        event.preventDefault();
        mainActionRef.current?.click();
      }
    };

    document.addEventListener('keydown', handleKeyboardNavigation);
    return () =>
      document.removeEventListener('keydown', handleKeyboardNavigation);
  });

  const primaryAction = actionableResult?.actions[0] ?? null;
  const secondaryActions = actionableResult?.actions.slice(1) ?? [];

  if (listQuery.isPending) {
    return (
      <div className="min-h-full w-full overflow-auto bg-background px-4 py-8 md:px-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <Skeleton className="h-8 w-52" />
          <ResultsSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col overflow-hidden bg-background px-4 py-6 md:px-8">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        <header className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Results</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Review automation reports and suggested follow-ups.
            </p>
          </div>
          {results.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={clearAllMutation.isPending}
              onClick={() => setIsClearConfirmOpen(true)}
            >
              Clear all
            </Button>
          ) : null}
        </header>

        {listQuery.isError && listQuery.data === undefined ? (
          <RetryableLoadError
            className="border"
            message="Failed to load results."
            isRetrying={listQuery.isFetching}
            onRetry={() => void listQuery.refetch()}
          />
        ) : results.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>You&apos;re all caught up</EmptyTitle>
            </EmptyHeader>
            <EmptyDescription>
              New automation reports and suggested follow-ups will appear here
              when they are ready.
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
            <ResponsiveWorkspacePanels
              isPanelOpen={selectedSummary !== null}
              mainSize={40}
              panelSize={60}
              mainMinSize={30}
              panelMinSize={40}
              panelId="result-detail"
              main={
                <div className="relative h-full min-h-0 overflow-hidden bg-background">
                  <div
                    ref={resultListRef}
                    role="list"
                    aria-label="Pending automation results"
                    className="scroll-thin h-full overflow-y-auto divide-y divide-card bg-background"
                    onScroll={updateResultScrollBoundaries}
                  >
                    {results.map((result) => {
                      const key = resultKey(result);
                      const isSelected = selectedKey === key;
                      return (
                        <div
                          key={key}
                          role="listitem"
                          className={cn(
                            'transition-colors',
                            isSelected
                              ? 'bg-accent-foreground text-black'
                              : 'hover:bg-accent-foreground/10',
                          )}
                        >
                          <button
                            ref={(node) => {
                              if (node) rowRefs.current.set(key, node);
                              else rowRefs.current.delete(key);
                            }}
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            data-result-select
                            className={cn(
                              'flex w-full cursor-pointer items-start gap-3 pt-4 pr-3 pb-0 pl-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                              isSelected ? 'text-black' : 'text-foreground',
                            )}
                            onClick={() => selectResult(result)}
                          >
                            <AutomationAvatar result={result} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start gap-2">
                                <span className="line-clamp-2 flex-1 text-base font-medium leading-snug">
                                  {result.headline}
                                </span>
                                <PriorityMarker
                                  result={result}
                                  selected={isSelected}
                                />
                              </span>
                              <span
                                className={cn(
                                  'mt-1 line-clamp-3 block text-sm leading-snug',
                                  isSelected
                                    ? 'text-black/80'
                                    : 'text-muted-foreground',
                                )}
                              >
                                {result.decisionContext}
                              </span>
                            </span>
                          </button>
                          <div
                            className={cn(
                              'mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 pr-3 pb-4 pl-[2.875rem] text-xs',
                              isSelected
                                ? 'text-black/75'
                                : 'text-muted-foreground',
                            )}
                          >
                            <span className="max-w-[55%] truncate">
                              {result.automationName}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0">
                              {formatDistanceToNowCompact(result.createdAt, {
                                addSuffix: true,
                              })}
                            </span>
                            {result.pullRequests.length > 0 ? (
                              <>
                                <span aria-hidden="true">·</span>
                                {result.pullRequests.map(
                                  (pullRequest, index) => (
                                    <Fragment key={pullRequest.url}>
                                      {index > 0 ? (
                                        <span aria-hidden="true">·</span>
                                      ) : null}
                                      <PullRequestBadge
                                        repo={pullRequest.repository}
                                        prNumber={pullRequest.number}
                                        url={pullRequest.url}
                                        title={pullRequest.title}
                                        size="xs"
                                        className="max-w-[12rem] min-w-0 text-inherit"
                                        iconClassName="text-inherit"
                                      />
                                    </Fragment>
                                  ),
                                )}
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div
                    aria-hidden="true"
                    data-visible={canScrollResultsUp}
                    className={cn(
                      'pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background to-transparent transition-transform motion-reduce:transition-none',
                      canScrollResultsUp ? 'opacity-80' : 'opacity-0',
                    )}
                  />
                  <div
                    aria-hidden="true"
                    data-visible={canScrollResultsDown}
                    className={cn(
                      'pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-background to-transparent transition-transform motion-reduce:transition-none',
                      canScrollResultsDown ? 'opacity-80' : 'opacity-0',
                    )}
                  />
                </div>
              }
              panel={
                selectedSummary ? (
                  showDetailSkeleton || !displayedResult ? (
                    <div className="h-full overflow-y-auto bg-card">
                      <DetailSkeleton />
                    </div>
                  ) : (
                    <article
                      aria-busy={isDetailTransition}
                      className="flex h-full min-h-0 flex-col bg-card text-left"
                    >
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="mr-auto w-full max-w-3xl px-5 pb-5 pt-6 text-left md:px-8 md:pb-5 md:pt-8">
                          <div className="flex items-start gap-3">
                            <AutomationAvatar
                              result={displayedResult}
                              size="large"
                            />
                            <div className="min-w-0 flex-1">
                              <h2
                                ref={detailHeadingRef}
                                tabIndex={-1}
                                className="text-balance text-xl font-semibold leading-tight outline-none"
                              >
                                {displayedResult.headline}
                              </h2>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {displayedResult.automationName} ·{' '}
                                {formatDistanceToNowCompact(
                                  displayedResult.createdAt,
                                  { addSuffix: true },
                                )}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="-mr-1.5 -mt-1.5 shrink-0"
                              aria-label="Close result details"
                              onClick={closeResultDetail}
                            >
                              <X />
                            </Button>
                          </div>
                        </div>
                        <div aria-hidden="true" className="border-t" />
                        <div className="mr-auto w-full max-w-3xl px-5 pb-6 pt-4 text-left md:px-8 md:pb-8 md:pl-10">
                          {displayedResult.decisionContext ? (
                            <p className="text-base leading-relaxed text-muted-foreground">
                              {displayedResult.decisionContext}
                            </p>
                          ) : null}
                          {showSuggestionComposer &&
                          actionableResult?.kind === 'suggestion' ? (
                            <div className="mt-4 rounded-xl border bg-card p-4">
                              <NewTaskForm
                                key={actionableResult.id}
                                animate={false}
                                initialPrompt={
                                  actionableResult.actions.find(
                                    (action) =>
                                      action.kind === 'start_suggestion',
                                  )?.initialPrompt ?? ''
                                }
                                placeholder="Add details"
                                textareaMaxHeight={260}
                                modelSelectorSize="base"
                                onTaskStarted={() => {
                                  capture('suggestion_start_succeeded', {
                                    kind: actionableResult.kind,
                                  });
                                  acceptSuggestionMutation.mutate({
                                    id: actionableResult.id,
                                  });
                                }}
                              />
                            </div>
                          ) : null}
                          {displayedResult.content ? (
                            <div className="mt-4 max-w-none">
                              <MessageResponse className="break-words text-sm **:data-[streamdown='heading-1']:text-xl! **:data-[streamdown='heading-2']:text-base! **:data-[streamdown='heading-3']:text-base!">
                                {displayedResult.content}
                              </MessageResponse>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card px-5 py-4 md:px-8">
                        {primaryAction?.kind === 'navigate' ? (
                          <Button asChild>
                            <Link
                              ref={mainActionRef as Ref<HTMLAnchorElement>}
                              href={primaryAction.href}
                              target={
                                primaryAction.external ? '_blank' : undefined
                              }
                              rel={
                                primaryAction.external
                                  ? 'noopener noreferrer'
                                  : undefined
                              }
                              onClick={() =>
                                capture('result_navigation_opened', {
                                  kind: actionableResult!.kind,
                                  action: primaryAction.action,
                                })
                              }
                            >
                              {primaryAction.label}
                            </Link>
                          </Button>
                        ) : primaryAction ? (
                          <Button
                            ref={mainActionRef as Ref<HTMLButtonElement>}
                            onClick={() => {
                              capture('suggestion_start_requested', {
                                kind: actionableResult!.kind,
                              });
                              setShowSuggestionComposer(true);
                            }}
                          >
                            {primaryAction.label}
                          </Button>
                        ) : null}
                        {secondaryActions.map((action) =>
                          action.kind === 'navigate' ? (
                            <Button
                              key={`${action.action}:${action.href}`}
                              variant="outline"
                              asChild
                            >
                              <Link
                                href={action.href}
                                target={action.external ? '_blank' : undefined}
                                rel={
                                  action.external
                                    ? 'noopener noreferrer'
                                    : undefined
                                }
                                onClick={() =>
                                  capture('result_navigation_opened', {
                                    kind: actionableResult!.kind,
                                    action: action.action,
                                  })
                                }
                              >
                                {action.label}
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              key={action.action}
                              variant="outline"
                              onClick={() => {
                                capture('suggestion_start_requested', {
                                  kind: actionableResult!.kind,
                                });
                                setShowSuggestionComposer(true);
                              }}
                            >
                              {action.label}
                            </Button>
                          ),
                        )}
                        <Button
                          variant="outline"
                          disabled={clearMutation.isPending || !selectedSummary}
                          onClick={() =>
                            selectedSummary && clearResult(selectedSummary)
                          }
                        >
                          <X />
                          Clear
                        </Button>
                        <p className="hidden self-center text-xs text-muted-foreground md:ml-auto md:block md:text-right">
                          {
                            'Use ↑/↓ keys to navigate, Return to act, Delete to clear'
                          }
                        </p>
                      </div>
                    </article>
                  )
                ) : null
              }
            />
          </div>
        )}
      </div>

      <Dialog open={isClearConfirmOpen} onOpenChange={setIsClearConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Clear all results?</DialogTitle>
            <DialogDescription>
              This removes {results.length} pending{' '}
              {results.length === 1 ? 'result' : 'results'} from the inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsClearConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={clearAllMutation.isPending}
              onClick={() => {
                setIsClearConfirmOpen(false);
                clearAllMutation.mutate();
              }}
            >
              Clear all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

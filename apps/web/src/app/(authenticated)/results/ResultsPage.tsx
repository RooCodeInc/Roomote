'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMediaQuery } from 'usehooks-ts';

import {
  ArrowLeft,
  Button,
  CircleAlert,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  ExternalLink,
  Play,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
  RetryableLoadError,
  Skeleton,
  TriangleAlert,
  X,
} from '@/components/system';
import { MessageResponse } from '@/components/ai-elements';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';
import { TaskAutomationIcon } from '@/components/tasks/TaskAutomationIcon';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { useResultsPage } from '@/hooks/useResultsPage';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useTRPC } from '@/trpc/client';
import type { ResultInboxItem } from '@/trpc/commands/results';

const EMPTY_RESULTS: ResultInboxItem[] = [];

function resultKey(result: Pick<ResultInboxItem, 'id' | 'kind'>) {
  return `${result.kind}:${result.id}`;
}

function AutomationAvatar({ result }: { result: ResultInboxItem }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-clip rounded-full border border-border bg-white ring-1 ring-card dark:bg-muted">
      <TaskAutomationIcon
        automationKey={result.automationKey}
        className="size-5"
      />
    </span>
  );
}

function PriorityMarker({ result }: { result: ResultInboxItem }) {
  if (result.priority === 'normal') return null;
  const Icon = result.priority === 'critical' ? TriangleAlert : CircleAlert;
  return (
    <Icon
      aria-label={`${result.priority === 'critical' ? 'Critical' : 'High'} priority`}
      className={
        result.priority === 'critical' ? 'text-destructive' : 'text-warning'
      }
      strokeWidth={2}
    />
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid min-h-[34rem] grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-[24rem_1fr]">
      <div className="space-y-1 bg-card p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="hidden space-y-4 bg-background p-8 lg:block">
        <Skeleton className="h-8 w-3/5" />
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

export function ResultsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { capture } = useTelemetry();
  const { enabled, isLoading: isFlagLoading } = useResultsPage();
  const isDesktop = useMediaQuery('(min-width: 1024px)', {
    initializeWithValue: false,
  });
  const [selectedKey, setSelectedKey] = useState(
    () => searchParams.get('result') ?? '',
  );
  const [showSuggestionComposer, setShowSuggestionComposer] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const trackedInboxViewRef = useRef(false);
  const listQueryKey = trpc.results.list.queryKey();
  const listQuery = useQuery(
    trpc.results.list.queryOptions(undefined, { enabled }),
  );

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
      onSettled: () => void invalidate(),
    }),
  );
  const clearAllMutation = useMutation(
    trpc.results.clear.mutationOptions({
      onSuccess: (result) => {
        capture('results_cleared_all', { count: result.clearedCount });
        setSelectedKey('');
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
    if (!isFlagLoading && !enabled) router.replace('/');
  }, [enabled, isFlagLoading, router]);

  const results = listQuery.data ?? EMPTY_RESULTS;
  const selected =
    results.find((result) => resultKey(result) === selectedKey) ?? null;

  useEffect(() => {
    if (isDesktop && !selectedKey && results[0]) {
      setSelectedKey(resultKey(results[0]));
    }
  }, [isDesktop, results, selectedKey]);

  useEffect(() => {
    if (!trackedInboxViewRef.current && listQuery.isSuccess) {
      trackedInboxViewRef.current = true;
      capture('results_inbox_viewed', { count: results.length });
    }
  }, [capture, listQuery.isSuccess, results.length]);

  const selectResult = (result: ResultInboxItem) => {
    const key = resultKey(result);
    setSelectedKey(key);
    setShowSuggestionComposer(false);
    capture('result_selected', {
      kind: result.kind,
      priority: result.priority,
      preparation: result.preparationStatus,
    });
    const params = new URLSearchParams(searchParams.toString());
    params.set('result', key);
    startTransition(() => router.replace(`/results?${params.toString()}`));
    requestAnimationFrame(() => detailHeadingRef.current?.focus());
  };

  const clearResult = (result: ResultInboxItem) => {
    const index = results.findIndex(
      (candidate) => resultKey(candidate) === resultKey(result),
    );
    const next = results[index + 1] ?? results[index - 1] ?? null;
    setSelectedKey(next ? resultKey(next) : '');
    capture('result_cleared', { kind: result.kind, priority: result.priority });
    clearMutation.mutate({ id: result.id, kind: result.kind });
  };

  if (isFlagLoading || !enabled || listQuery.isPending) {
    return (
      <div className="min-h-full w-full space-y-6 overflow-auto bg-background px-4 py-8 md:px-8">
        <Skeleton className="h-8 w-52" />
        <ResultsSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col overflow-hidden bg-background px-4 py-6 md:px-8">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Results</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Outcomes and decisions from your automations.
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
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No pending results</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card"
        >
          <ResizablePanel
            id="results-list"
            order={1}
            defaultSize={34}
            minSize={25}
            maxSize={48}
            className={selected ? 'hidden lg:block' : 'block'}
          >
            <div
              role="listbox"
              aria-label="Pending automation results"
              className="h-full overflow-y-auto p-2"
            >
              {results.map((result, index) => {
                const key = resultKey(result);
                const isSelected = selected && resultKey(selected) === key;
                return (
                  <button
                    key={key}
                    ref={(node) => {
                      if (node) rowRefs.current.set(key, node);
                      else rowRefs.current.delete(key);
                    }}
                    type="button"
                    role="option"
                    aria-selected={Boolean(isSelected)}
                    className={`mb-1 flex w-full gap-3 rounded-lg p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                      isSelected
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/70'
                    }`}
                    onClick={() => selectResult(result)}
                    onKeyDown={(event) => {
                      const nextIndex =
                        event.key === 'ArrowDown'
                          ? index + 1
                          : event.key === 'ArrowUp'
                            ? index - 1
                            : -1;
                      if (nextIndex >= 0 && nextIndex < results.length) {
                        event.preventDefault();
                        rowRefs.current
                          .get(resultKey(results[nextIndex]!))
                          ?.focus();
                      }
                    }}
                  >
                    <AutomationAvatar result={result} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-2">
                        <span className="line-clamp-2 flex-1 text-sm font-semibold leading-snug">
                          {result.headline}
                        </span>
                        <PriorityMarker result={result} />
                      </span>
                      <span className="mt-1 line-clamp-2 block text-sm leading-snug text-muted-foreground">
                        {result.decisionContext}
                      </span>
                      <span className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">
                          {result.automationName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">
                          {formatDistanceToNowCompact(result.createdAt, {
                            addSuffix: true,
                          })}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </ResizablePanel>
          <ResizableDivider className="hidden lg:flex" />
          <ResizablePanel
            id="result-detail"
            order={2}
            defaultSize={66}
            minSize={45}
            className={selected ? 'block' : 'hidden lg:block'}
          >
            {selected ? (
              <article className="h-full overflow-y-auto">
                <div className="mx-auto max-w-3xl px-5 py-6 md:px-8 md:py-8">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mb-4 -ml-2 lg:hidden"
                    onClick={() => {
                      const prior = selectedKey;
                      setSelectedKey('');
                      const params = new URLSearchParams(
                        searchParams.toString(),
                      );
                      params.delete('result');
                      router.replace(
                        params.size > 0
                          ? `/results?${params.toString()}`
                          : '/results',
                      );
                      requestAnimationFrame(() =>
                        rowRefs.current.get(prior)?.focus(),
                      );
                    }}
                  >
                    <ArrowLeft />
                    Back to results
                  </Button>
                  <div className="flex items-start gap-3">
                    <AutomationAvatar result={selected} />
                    <div className="min-w-0 flex-1">
                      <h2
                        ref={detailHeadingRef}
                        tabIndex={-1}
                        className="text-balance text-2xl font-semibold leading-tight outline-none"
                      >
                        {selected.headline}
                      </h2>
                      <p className="mt-2 text-base leading-relaxed text-muted-foreground">
                        {selected.decisionContext}
                      </p>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {selected.automationName} ·{' '}
                        {formatDistanceToNowCompact(selected.createdAt, {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap gap-2 border-y py-4">
                    {selected.actions.map((action) =>
                      action.kind === 'navigate' ? (
                        <Button key={`${action.action}:${action.href}`} asChild>
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
                                kind: selected.kind,
                                action: action.action,
                              })
                            }
                          >
                            {action.label}
                            {action.external ? <ExternalLink /> : null}
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          key={action.action}
                          onClick={() => {
                            capture('suggestion_start_requested', {
                              kind: selected.kind,
                            });
                            setShowSuggestionComposer(true);
                          }}
                        >
                          <Play />
                          {action.label}
                        </Button>
                      ),
                    )}
                    <Button
                      variant="outline"
                      disabled={clearMutation.isPending}
                      onClick={() => clearResult(selected)}
                    >
                      <X />
                      Clear
                    </Button>
                  </div>

                  {showSuggestionComposer && selected.kind === 'suggestion' ? (
                    <div className="mt-6 rounded-xl border bg-card p-4">
                      <NewTaskForm
                        key={selected.id}
                        animate={false}
                        initialPrompt={
                          selected.actions.find(
                            (action) => action.kind === 'start_suggestion',
                          )?.initialPrompt ?? ''
                        }
                        placeholder="Add details"
                        textareaMaxHeight={260}
                        onTaskStarted={() => {
                          capture('suggestion_start_succeeded', {
                            kind: selected.kind,
                          });
                          acceptSuggestionMutation.mutate({ id: selected.id });
                        }}
                      />
                    </div>
                  ) : null}

                  <div className="prose prose-neutral mt-7 max-w-none dark:prose-invert">
                    <MessageResponse>{selected.content}</MessageResponse>
                  </div>
                </div>
              </article>
            ) : (
              <div className="hidden h-full items-center justify-center text-sm text-muted-foreground lg:flex">
                Select a result to read it.
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

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

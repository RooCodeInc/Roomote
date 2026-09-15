'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import removeMd from 'remove-markdown';
import { toast } from 'sonner';

import {
  BasicTooltip,
  Button,
  Card,
  CardContent,
  Check,
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
  RetryableLoadError,
  Skeleton,
  TriangleAlert,
  X,
} from '@/components/system';
import { CustomLink, MessageResponse } from '@/components/ai-elements';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';
import { TaskAutomationIcon } from '@/components/tasks/TaskAutomationIcon';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { useResultsPage } from '@/hooks/useResultsPage';
import { useTRPC } from '@/trpc/client';
import type { ResultInboxItem } from '@/trpc/commands/results';

function resultPreview(result: ResultInboxItem) {
  return (
    result.title ??
    removeMd(result.content).replaceAll('\\n', ' ').replace(/\s+/gu, ' ').trim()
  );
}

function resultTitle(result: ResultInboxItem) {
  const title = result.title ?? resultPreview(result);
  return title.length > 140 ? `${title.slice(0, 137)}...` : title;
}

function resultPrompt(result: ResultInboxItem) {
  return result.title
    ? `${result.title}\n\n${result.content}`.trim()
    : result.content;
}

function ignoredResultToastTitle(result: ResultInboxItem) {
  const title = result.title ?? resultPreview(result);
  return title.length > 30 ? `${title.slice(0, 30)}...` : title;
}

function ResultTextBlock({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function ResultTextInline({ children }: { children?: ReactNode }) {
  return <span>{children}</span>;
}

function ResultImageText({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}

const resultMarkdownComponents = {
  a: CustomLink,
  blockquote: ResultTextBlock,
  code: ResultTextInline,
  del: ResultTextInline,
  em: ResultTextInline,
  h1: ResultTextBlock,
  h2: ResultTextBlock,
  h3: ResultTextBlock,
  h4: ResultTextBlock,
  h5: ResultTextBlock,
  h6: ResultTextBlock,
  img: ResultImageText,
  li: ResultTextBlock,
  ol: ResultTextBlock,
  p: ResultTextBlock,
  pre: ResultTextBlock,
  strong: ResultTextInline,
  ul: ResultTextBlock,
};

function AutomationAvatar({ result }: { result: ResultInboxItem }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center overflow-clip rounded-full border border-border bg-white ring-1 ring-card dark:bg-muted">
      <TaskAutomationIcon
        automationKey={result.automationKey}
        className="size-4"
      />
    </span>
  );
}

function PriorityMarker({
  priority,
}: {
  priority: ResultInboxItem['priority'];
}) {
  if (priority === 'normal') return null;

  const Icon = priority === 'critical' ? TriangleAlert : CircleAlert;
  const label = priority === 'critical' ? 'Critical priority' : 'High priority';

  return (
    <Icon
      aria-label={label}
      className={`size-5 ${
        priority === 'critical' ? 'text-destructive' : 'text-warning'
      }`}
      strokeWidth={2}
    />
  );
}

function ResultContent({ result }: { result: ResultInboxItem }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || expanded) return;

    const measure = () => {
      setTruncated(content.scrollHeight > content.clientHeight + 1);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className="min-w-0">
      <div
        ref={contentRef}
        data-testid={`result-content-${result.id}`}
        className={
          expanded
            ? 'text-sm leading-normal text-foreground'
            : 'line-clamp-3 text-sm leading-normal text-foreground'
        }
      >
        <MessageResponse
          components={resultMarkdownComponents}
          pullRequestRepositoryUrl={result.repositoryUrl}
        >
          {result.title ?? result.content.replaceAll('\\n', ' ')}
        </MessageResponse>
      </div>
      {truncated && !expanded ? (
        <button
          type="button"
          className="mt-0.5 block cursor-pointer bg-transparent text-sm font-medium text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
        >
          More
        </button>
      ) : null}
    </div>
  );
}

export function ResultsPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { enabled, isLoading: isFlagLoading } = useResultsPage();
  const [selected, setSelected] = useState<ResultInboxItem | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const listQueryKey = trpc.results.list.queryKey();
  const listQuery = useQuery(
    trpc.results.list.queryOptions(undefined, { enabled }),
  );
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listQueryKey }),
      queryClient.invalidateQueries({
        queryKey: trpc.results.unreadCount.queryKey(),
      }),
    ]);
  };
  const actionMutation = useMutation(
    trpc.results.act.mutationOptions({
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
        if (selected?.id === variables.id && selected.kind === variables.kind) {
          setSelected(null);
        }
        return { previous };
      },
      onError: (error, _variables, context) => {
        queryClient.setQueryData(listQueryKey, context?.previous);
        toast.error(error.message);
      },
      onSettled: () => void invalidate(),
    }),
  );
  const clearMutation = useMutation(
    trpc.results.clear.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: listQueryKey });
        const previous =
          queryClient.getQueryData<ResultInboxItem[]>(listQueryKey);
        queryClient.setQueryData<ResultInboxItem[]>(listQueryKey, []);
        setSelected(null);
        return { previous };
      },
      onError: (error, _variables, context) => {
        queryClient.setQueryData(listQueryKey, context?.previous);
        toast.error(error.message);
      },
      onSettled: () => void invalidate(),
    }),
  );

  useEffect(() => {
    if (!isFlagLoading && !enabled) router.replace('/');
  }, [enabled, isFlagLoading, router]);

  if (isFlagLoading || !enabled || listQuery.isPending) {
    return (
      <div className="min-h-full w-full space-y-6 overflow-auto bg-background px-4 py-8 md:px-8">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const results = listQuery.data ?? [];
  const actOnResult = (
    result: ResultInboxItem,
    action: 'accept' | 'ignore',
  ) => {
    const ignoredTitle =
      action === 'ignore' && result.kind === 'suggestion'
        ? ignoredResultToastTitle(result)
        : null;
    actionMutation.mutate(
      { id: result.id, kind: result.kind, action },
      {
        onSuccess: () => {
          if (ignoredTitle) toast.success(`${ignoredTitle} was ignored`);
        },
      },
    );
  };

  return (
    <div className="min-h-full w-full overflow-auto bg-background px-4 py-8 md:px-8">
      <div className="max-w-8xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-foreground">
            Automation Results
          </h1>
          {results.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={clearMutation.isPending}
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
              <EmptyTitle>No unread results</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card variant="snug" className="gap-0 p-0">
            <CardContent className="p-0!">
              <div
                role="row"
                className="mb-0 hidden grid-cols-[3rem_5.5rem_minmax(0,2fr)_minmax(0,8fr)_5rem] gap-4 border-b border-background px-6 py-2 text-xs font-medium text-muted-foreground md:grid"
              >
                <span aria-hidden="true" />
                <span role="columnheader">Produced</span>
                <span role="columnheader">Automation</span>
                <span role="columnheader">Result</span>
                <span role="columnheader" className="sr-only">
                  Actions
                </span>
              </div>
              <div role="rowgroup" className="divide-y divide-background">
                {results.map((result) => (
                  <div
                    key={`${result.kind}:${result.id}`}
                    role="row"
                    className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-4 py-3 transition-colors hover:bg-accent-foreground/20 md:grid-cols-[3rem_5.5rem_minmax(0,2fr)_minmax(0,8fr)_5rem] md:gap-4 md:px-6"
                    tabIndex={0}
                    onClick={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest('a, button')
                      ) {
                        return;
                      }
                      setSelected(result);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest('a, button')
                      ) {
                        return;
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelected(result);
                      }
                    }}
                  >
                    <div
                      role="cell"
                      className="col-start-2 row-start-1 flex justify-end md:col-start-1 md:justify-center"
                    >
                      <PriorityMarker priority={result.priority} />
                    </div>
                    <div
                      role="cell"
                      className="col-start-1 row-start-2 pl-7 text-xs text-muted-foreground md:col-start-2 md:row-start-1 md:pl-0 md:text-sm"
                    >
                      {formatDistanceToNowCompact(result.createdAt, {
                        addSuffix: true,
                      })}
                    </div>
                    <div
                      role="cell"
                      className="col-start-1 row-start-1 flex min-w-0 items-start gap-2 md:col-start-3"
                    >
                      <AutomationAvatar result={result} />
                      <span className="truncate text-sm font-semibold">
                        {result.automationName}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="col-span-2 col-start-1 row-start-3 min-w-0 pl-7 text-foreground md:col-span-1 md:col-start-4 md:row-start-1 md:pl-0"
                    >
                      <ResultContent result={result} />
                    </div>
                    <div
                      role="cell"
                      className="col-span-2 col-start-1 row-start-4 -ml-2 flex items-start gap-1 pl-7 md:col-span-1 md:col-start-5 md:row-start-1 md:ml-0 md:justify-end md:pl-0"
                    >
                      <BasicTooltip content="Accept">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="hover:text-accent-foreground"
                          aria-label={`Accept ${resultTitle(result)}`}
                          disabled={actionMutation.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            actOnResult(result, 'accept');
                          }}
                        >
                          <Check />
                        </Button>
                      </BasicTooltip>
                      <BasicTooltip content="Clear">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="hover:text-destructive"
                          aria-label={`Clear ${resultTitle(result)}`}
                          disabled={actionMutation.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            actOnResult(result, 'ignore');
                          }}
                        >
                          <X />
                        </Button>
                      </BasicTooltip>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent size="4xl" className="[&_textarea]:md:min-h-42">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>{resultTitle(selected)}</DialogTitle>
                <DialogDescription asChild>
                  <div className="flex items-center gap-1.5">
                    <AutomationAvatar result={selected} />
                    <span>{selected.automationName}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>
                      {formatDistanceToNowCompact(selected.createdAt, {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <NewTaskForm
                key={`${selected.kind}:${selected.id}`}
                animate={false}
                initialPrompt={resultPrompt(selected)}
                placeholder="Add details"
                textareaMaxHeight={320}
                onTaskStarted={() => actOnResult(selected, 'accept')}
              />
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actOnResult(selected, 'ignore')}
                >
                  <X />
                  Clear
                </Button>
                <Button variant="outline" onClick={() => setSelected(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={isClearConfirmOpen} onOpenChange={setIsClearConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Clear all results?</DialogTitle>
            <DialogDescription>
              This will ignore all unread automation results.
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
              disabled={clearMutation.isPending}
              onClick={() => {
                setIsClearConfirmOpen(false);
                clearMutation.mutate();
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

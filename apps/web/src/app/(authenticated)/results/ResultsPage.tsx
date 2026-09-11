'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Streamdown } from 'streamdown';
import removeMd from 'remove-markdown';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/system';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { useResultsPage } from '@/hooks/useResultsPage';
import { useTRPC } from '@/trpc/client';
import type { ResultInboxItem } from '@/trpc/commands/results';

function priorityVariant(priority: ResultInboxItem['priority']) {
  return priority === 'critical'
    ? ('destructive' as const)
    : priority === 'high'
      ? ('warning' as const)
      : ('secondary' as const);
}

function resultPreview(result: ResultInboxItem) {
  return (
    result.title ??
    removeMd(result.content).replaceAll('\\n', ' ').replace(/\s+/gu, ' ').trim()
  );
}

export function ResultsPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { enabled, isLoading: isFlagLoading } = useResultsPage();
  const [selected, setSelected] = useState<ResultInboxItem | null>(null);
  const listQuery = useQuery(
    trpc.results.list.queryOptions(undefined, { enabled }),
  );
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.results.list.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: trpc.results.unreadCount.queryKey(),
      }),
    ]);
  };
  const actionMutation = useMutation(
    trpc.results.act.mutationOptions({
      onSuccess: () => {
        setSelected(null);
        void invalidate();
      },
    }),
  );
  const clearMutation = useMutation(
    trpc.results.clear.mutationOptions({ onSuccess: () => void invalidate() }),
  );

  useEffect(() => {
    if (!isFlagLoading && !enabled) router.replace('/');
  }, [enabled, isFlagLoading, router]);

  if (isFlagLoading || !enabled || listQuery.isPending) {
    return (
      <div className="min-h-full w-full space-y-6 overflow-auto bg-background px-4 py-8 md:px-8">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const results = listQuery.data ?? [];

  return (
    <div className="min-h-full w-full overflow-auto bg-background px-4 py-8 md:px-8">
      <div className="max-w-8xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-foreground">Results</h1>
          {results.length > 0 ? (
            <Button
              variant="outline"
              disabled={clearMutation.isPending}
              onClick={() => clearMutation.mutate()}
            >
              Clear
            </Button>
          ) : null}
        </header>

        {results.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No unread results</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((result) => (
                  <TableRow
                    key={`${result.kind}:${result.id}`}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelected(result)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelected(result);
                      }
                    }}
                  >
                    <TableCell className="font-semibold">
                      {result.automationName}
                    </TableCell>
                    <TableCell className="max-w-xl truncate">
                      {resultPreview(result)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={priorityVariant(result.priority)}>
                        {result.priority}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDistanceToNowCompact(result.createdAt, {
                        addSuffix: true,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent size="4xl" aria-describedby={undefined}>
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>{selected.automationName}</DialogTitle>
                <div className="text-sm text-muted-foreground">
                  {formatDistanceToNowCompact(selected.createdAt, {
                    addSuffix: true,
                  })}
                </div>
              </DialogHeader>
              {selected.title ? (
                <h2 className="text-lg font-semibold">{selected.title}</h2>
              ) : null}
              <Streamdown className="break-words text-sm">
                {selected.content}
              </Streamdown>
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() =>
                    actionMutation.mutate({
                      id: selected.id,
                      kind: selected.kind,
                      action: 'ignore',
                    })
                  }
                >
                  Ignore
                </Button>
                <Button
                  disabled={actionMutation.isPending}
                  onClick={() =>
                    actionMutation.mutate({
                      id: selected.id,
                      kind: selected.kind,
                      action: 'accept',
                    })
                  }
                >
                  Accept
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

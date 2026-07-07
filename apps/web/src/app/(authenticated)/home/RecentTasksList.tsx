'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import { useAuthorizedUser } from '@/hooks/useUser';

import { ModelBadge } from '@/components/sandbox/ModelBadge';
import { WorkspaceBadge } from '@/components/sandbox/WorkspaceBadge';
import { ArrowRight, Button, Skeleton } from '@/components/system';
import { formatDistanceToNowCompact } from '@/lib/formatters';

type RecentTasksListProps = {
  enabled: boolean;
};

export function RecentTasksList({ enabled }: RecentTasksListProps) {
  const { userId } = useAuthorizedUser();
  const trpc = useTRPC();

  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions(
      {
        limit: 15,
        filters: [{ type: 'userId', value: userId, label: 'You' }],
        timePeriod: 'all',
      },
      { enabled },
    ),
  );

  if (tasksQuery.isPending) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const tasks = tasksQuery.data?.tasks ?? [];

  if (tasks.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No recent tasks. What have you been up to?
      </p>
    );
  }

  return (
    <>
      <div className="divide-y divide-background">
        {tasks.map((task) => (
          <div key={task.id}>
            <Link
              href={`/task/${task.id}`}
              className="flex items-center px-4 py-3 hover:bg-muted/40"
            >
              <div className="min-w-0 flex-1 flex gap-2">
                <p className="truncate text-sm grow">{task.title}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <WorkspaceBadge
                    environmentId={task.cloudJob?.payload?.environmentId}
                    repo={
                      task.cloudJob?.payload?.repo ??
                      task.repositoryName ??
                      undefined
                    }
                    iconClassName="size-3"
                  />
                  <ModelBadge
                    model={task.model}
                    displayName={task.modelDisplayName}
                    iconClassName="size-3"
                  />
                  <span> · </span>
                  <span className="truncate">
                    {formatDistanceToNowCompact(
                      new Date(task.timestamp * 1000),
                      {
                        addSuffix: false,
                      },
                    )}
                  </span>
                </div>
              </div>
            </Link>
          </div>
        ))}
        <div className="py-2 px-3">
          <Button asChild variant="link">
            <Link href="/tasks" className="flex items-center gap-2 text-sm">
              <span>All tasks</span>
              <ArrowRight className="size-3" />
            </Link>
          </Button>
        </div>
      </div>
    </>
  );
}

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { getUserDisplayName } from '@/lib';
import { Avatar, Badge } from '@/components/system';

type SessionCardData = {
  id: string;
  title: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  sourceSurface: string;
  activityAt: number;
  cachedStatus: 'active' | 'needs_input' | 'blocked' | 'ready' | null;
  executionCount: number;
  inferenceCostMicroUsd: number;
  unread: boolean;
  tasks: Array<{
    taskId: string;
    workflow: string;
    repositoryName: string | null;
  }>;
};

const STATUS_VARIANTS = {
  active: 'success',
  needs_input: 'warning',
  blocked: 'destructive',
  ready: 'secondary',
} as const;

export function SessionCard({ session }: { session: SessionCardData }) {
  const owner =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Roomote';
  const primaryTask = session.tasks[0];
  const status = session.cachedStatus ?? 'ready';

  return (
    <Link
      href={`/sessions/${session.id}${primaryTask ? `?task=${primaryTask.taskId}` : ''}`}
      className="ph-no-capture group flex w-full items-start gap-3 p-4 transition-colors hover:bg-accent-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative mt-1 shrink-0">
        <Avatar
          imageUrl={session.ownerImageUrl}
          name={owner}
          email={session.ownerEmail ?? undefined}
          size="md"
          alt={owner}
        />
        {session.unread ? (
          <span
            aria-label="Unread activity"
            className="absolute -top-1 -right-1 size-3 rounded-full bg-primary ring-2 ring-background"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="line-clamp-2 text-base font-medium group-hover:underline">
            {session.title}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(session.activityAt * 1000), {
              addSuffix: true,
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={STATUS_VARIANTS[status]}>
            {status.replace('_', ' ')}
          </Badge>
          <span>{session.executionCount} executions</span>
          <span>{session.sourceSurface}</span>
          {primaryTask?.repositoryName ? (
            <span>{primaryTask.repositoryName}</span>
          ) : null}
          <span>${(session.inferenceCostMicroUsd / 1_000_000).toFixed(4)}</span>
        </div>
      </div>
    </Link>
  );
}

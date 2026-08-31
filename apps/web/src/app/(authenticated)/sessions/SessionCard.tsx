import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import {
  formatInferenceCost,
  formatRepositoryName,
  getUserDisplayName,
} from '@/lib';
import { Avatar, Spinner } from '@/components/system';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import { SessionSearchSnippet } from '@/components/sessions/SessionSearchSnippet';
import { getSessionSurfaceLabel } from '@/components/sessions/session-surfaces';

type SessionCardData = {
  id: string;
  title: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  ownerUserId: string | null;
  sourceSurface: string;
  activityAt: number;
  cachedStatus: 'active' | 'needs_input' | 'blocked' | 'ready' | null;
  executionCount: number;
  inferenceCostMicroUsd: number;
  unread: boolean;
  searchSnippet?: string | null;
  tasks: Array<{
    taskId: string;
    workflow: string;
    repositoryName: string | null;
  }>;
};

export function SessionCard({
  session,
  viewerUserId,
  query = '',
}: {
  session: SessionCardData;
  viewerUserId: string;
  query?: string;
}) {
  const owner =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Roomote';
  const primaryTask = session.tasks[0];
  const status = session.cachedStatus ?? 'ready';

  return (
    <Link
      href={`/sessions/${session.id}`}
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
        {session.unread && session.ownerUserId === viewerUserId ? (
          <span
            aria-label="Unread activity"
            className="absolute top-0 right-0 size-2 rounded-full bg-accent-foreground ring-2 ring-background"
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
        <SessionSearchSnippet
          snippet={session.searchSnippet}
          query={query}
          className="line-clamp-2"
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {status === 'active' ? (
            <Spinner />
          ) : status === 'ready' ? null : (
            <SessionStatusBadge status={status} className="capitalize" />
          )}
          <span>{getSessionSurfaceLabel(session.sourceSurface)}</span>
          {primaryTask?.repositoryName ? (
            <span>{formatRepositoryName(primaryTask.repositoryName)}</span>
          ) : null}
          {session.executionCount > 0 ? (
            <span>
              {session.executionCount} execution
              {session.executionCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {session.inferenceCostMicroUsd > 0 ? (
            <span>${formatInferenceCost(session.inferenceCostMicroUsd)}</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

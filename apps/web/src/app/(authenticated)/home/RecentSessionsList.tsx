'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { useRecentSessions } from '@/hooks/useRecentSessions';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import { ArrowRight, Button, Skeleton } from '@/components/system';

const MAX_VISIBLE_SESSIONS = 15;

type RecentSessionsListProps = {
  enabled: boolean;
};

export function RecentSessionsList({ enabled }: RecentSessionsListProps) {
  const trpc = useTRPC();
  const { recentSessionIds } = useRecentSessions();
  const sessionIds = useMemo(
    () => recentSessionIds.slice(0, MAX_VISIBLE_SESSIONS),
    [recentSessionIds],
  );
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions(
      { ids: sessionIds, limit: MAX_VISIBLE_SESSIONS },
      { enabled: enabled && sessionIds.length > 0 },
    ),
  );
  const sessions = useMemo(() => {
    const sessionsById = new Map(
      (sessionsQuery.data?.sessions ?? []).map((session) => [
        session.id,
        session,
      ]),
    );
    return sessionIds
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is NonNullable<typeof session> => !!session);
  }, [sessionIds, sessionsQuery.data?.sessions]);

  if (sessionIds.length > 0 && sessionsQuery.isPending) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No recent sessions. What have you been up to?
      </p>
    );
  }

  return (
    <div className="divide-y divide-background">
      {sessions.map((session) => (
        <div key={session.id}>
          <Link
            href={`/sessions/${session.id}`}
            className="flex items-center px-4 py-3 hover:bg-muted/40"
          >
            <div className="min-w-0 flex-1 flex gap-2">
              <p className="truncate text-sm grow">{session.title}</p>
              <span className="mt-1 shrink-0 text-xs text-muted-foreground">
                {formatDistanceToNowCompact(
                  new Date(session.activityAt * 1000),
                  { addSuffix: false },
                )}
              </span>
            </div>
          </Link>
        </div>
      ))}
      <div className="py-2 px-3">
        <Button asChild variant="link">
          <Link href="/sessions" className="flex items-center gap-2 text-sm">
            <span>All sessions</span>
            <ArrowRight className="size-3" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

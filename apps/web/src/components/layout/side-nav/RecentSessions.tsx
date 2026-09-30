'use client';

import { useId } from 'react';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { Button } from '@/components/system';

import { SideNavSessionItem } from './SideNavSessionItem';

const RECENT_SESSIONS_LIMIT = 20;

export function getSessionIdFromPathname(pathname: string) {
  return pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
}

export function RecentSessions({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const currentSessionId = getSessionIdFromPathname(pathname);
  const headingId = useId();
  const trpc = useTRPC();
  const { data, isError, isFetching, refetch } = useQuery(
    trpc.sessions.list.queryOptions(
      { ownedOnly: true, limit: RECENT_SESSIONS_LIMIT },
      {
        enabled,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const sessions = data?.sessions ?? [];
  const initialLoadFailed = isError && data === undefined;

  if (!enabled || (!initialLoadFailed && sessions.length === 0)) return null;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="px-2 py-1 text-sm font-semibold">
        Recent sessions
      </h3>
      {initialLoadFailed ? (
        <div className="px-2 py-1">
          <p className="text-xs text-muted-foreground">
            Unable to load recent sessions.
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col">
          {sessions.map((session) => (
            <SideNavSessionItem
              key={session.id}
              session={session}
              isActive={currentSessionId === session.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

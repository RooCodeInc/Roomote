'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMediaQuery } from 'usehooks-ts';

import { SideNavSessionItem } from '@/components/layout/side-nav/SideNavSessionItem';
import { useTRPC } from '@/trpc/client';

const MOBILE_SESSION_LIMIT = 20;

function getSessionId(pathname: string) {
  return pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
}

export function MobileSessionSwitcher() {
  const pathname = usePathname();
  const currentSessionId = getSessionId(pathname);
  const isMobile = useMediaQuery('(max-width: 767px)', {
    initializeWithValue: false,
  });
  const trpc = useTRPC();
  const { data, refetch } = useQuery(
    trpc.sessions.list.queryOptions(
      { ownedOnly: true, limit: MOBILE_SESSION_LIMIT },
      {
        enabled: isMobile,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const sessions = data?.sessions ?? [];

  useEffect(() => {
    if (isMobile && currentSessionId) void refetch();
  }, [currentSessionId, isMobile, refetch]);

  if (sessions.length === 0) return null;

  return (
    <section aria-labelledby="mobile-recent-sessions-heading" className="pt-4">
      <h3
        id="mobile-recent-sessions-heading"
        className="px-2 py-1 text-sm font-semibold"
      >
        Recent sessions
      </h3>
      <div className="flex flex-col">
        {sessions.map((session) => (
          <SideNavSessionItem
            key={session.id}
            session={session}
            isActive={currentSessionId === session.id}
            showStatus
          />
        ))}
      </div>
    </section>
  );
}

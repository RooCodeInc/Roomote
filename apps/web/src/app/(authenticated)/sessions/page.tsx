import Link from 'next/link';
import { notFound } from 'next/navigation';

import { parseTimePeriodParam } from '@/types';
import { authorize } from '@/lib/server/auth-context';
import { getFastSessions } from '@/lib/server/fast-sessions';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/system';

import { FastSessionCard } from './FastSessionCard';
import { SessionsFilters } from './SessionsFilters';

export default async function SessionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ before?: string; user?: string; period?: string }>;
}) {
  const [authorizedUser, { before, user, period } = {}] = await Promise.all([
    authorize(),
    searchParams,
  ]);
  if (!authorizedUser.success) {
    notFound();
  }

  const timePeriod = parseTimePeriodParam(period ?? null, 'all');
  const { sessions, nextCursor } = await getFastSessions(authorizedUser, {
    before,
    filterUserId: user ?? null,
    timePeriod,
  });

  const olderParams = new URLSearchParams();
  if (nextCursor) olderParams.set('before', nextCursor);
  if (user) olderParams.set('user', user);
  if (timePeriod !== 'all') olderParams.set('period', String(timePeriod));

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="border-b-4 border-b-card bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SessionsFilters userId={user ?? null} timePeriod={timePeriod} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No sessions yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-card">
              {sessions.map((session) => (
                <FastSessionCard
                  key={session.id}
                  session={session}
                  showOwner={session.userId !== authorizedUser.userId}
                />
              ))}
              {nextCursor ? (
                <div className="flex justify-center p-4">
                  <Link
                    href={`/sessions?${olderParams.toString()}`}
                    className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Show older sessions
                  </Link>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

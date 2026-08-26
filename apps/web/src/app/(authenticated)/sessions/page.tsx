import Link from 'next/link';
import { notFound } from 'next/navigation';

import { parseTimePeriodParam } from '@/types';
import { authorize } from '@/lib/server/auth-context';
import { getFastSessions } from '@/lib/server/fast-sessions';
import { getSessions, type SessionScope } from '@/lib/server/sessions';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/system';

import { FastSessionCard } from './FastSessionCard';
import { SessionsFilters } from './SessionsFilters';
import { SessionCard } from './SessionCard';

export default async function SessionsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    before?: string;
    user?: string;
    period?: string;
    scope?: string;
    status?: string;
    view?: string;
    q?: string;
    repository?: string;
    environment?: string;
    pullRequest?: string;
    source?: string;
    model?: string;
  }>;
}) {
  const [authorizedUser, params = {}] = await Promise.all([
    authorize(),
    searchParams,
  ]);
  if (!authorizedUser.success) {
    notFound();
  }
  const { before, user, period, q } = params;
  const unified = authorizedUser.featureFlags.sessions_ui === true;
  const scope = ['all', 'tasks', 'reviews', 'automations'].includes(
    params.scope ?? '',
  )
    ? (params.scope as SessionScope)
    : 'all';
  const status = ['active', 'needs_input', 'blocked', 'ready'].includes(
    params.status ?? '',
  )
    ? (params.status as 'active' | 'needs_input' | 'blocked' | 'ready')
    : undefined;
  const view = params.view === 'board' ? 'board' : 'list';

  const timePeriod = parseTimePeriodParam(period ?? null, 'all');
  if (unified) {
    const result = await getSessions(authorizedUser, {
      before,
      user,
      period: timePeriod,
      scope,
      status,
      q,
      repository: params.repository,
      environment: params.environment,
      pullRequest: params.pullRequest,
      source: params.source,
      model: params.model,
    });
    const olderParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value && key !== 'before') olderParams.set(key, value);
    });
    if (result.nextCursor) olderParams.set('before', result.nextCursor);
    const columns = ['active', 'needs_input', 'blocked', 'ready'] as const;

    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-card">
        <div className="border-b-4 border-b-card bg-background p-4">
          <SessionsFilters
            unified
            userId={user ?? null}
            timePeriod={timePeriod}
            scope={scope}
            status={status ?? 'all'}
            view={view}
            query={q ?? ''}
            repository={params.repository ?? null}
            environment={params.environment ?? ''}
            pullRequest={params.pullRequest ?? null}
            source={params.source ?? 'all'}
            model={params.model ?? null}
          />
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto bg-background">
          {result.sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No sessions found.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : view === 'board' ? (
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
              {columns.map((column) => (
                <section key={column} aria-labelledby={`session-${column}`}>
                  <h2
                    id={`session-${column}`}
                    className="mb-2 text-sm font-medium capitalize"
                  >
                    {column.replace('_', ' ')}
                  </h2>
                  <div className="divide-y rounded-lg border bg-card">
                    {result.sessions
                      .filter((session) =>
                        column === 'ready'
                          ? !session.cachedStatus ||
                            session.cachedStatus === column
                          : session.cachedStatus === column,
                      )
                      .map((session) => (
                        <SessionCard key={session.id} session={session} />
                      ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-card">
              {result.sessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          )}
          {result.nextCursor ? (
            <div className="flex justify-center p-4">
              <Link
                href={`/sessions?${olderParams.toString()}`}
                className="text-sm underline-offset-4 hover:underline"
              >
                Show older sessions
              </Link>
            </div>
          ) : null}
        </main>
      </div>
    );
  }
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

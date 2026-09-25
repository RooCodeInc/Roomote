import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  getSessionBoardColumn,
  getSessionStatusLabel,
  SESSION_BOARD_COLUMNS,
  SESSION_STATUSES,
  type SessionStatus,
} from '@roomote/types';
import { getDeploymentExperiments } from '@roomote/db/server';

import { parseTimePeriodParam } from '@/types';
import { authorize } from '@/lib/server/auth-context';
import {
  getSessions,
  getSessionSources,
  type SessionScope,
} from '@/lib/server/sessions';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/system';

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
    pullRequest?: string;
    source?: string;
    model?: string;
  }>;
}) {
  const [authorizedUser, params = {}, experiments] = await Promise.all([
    authorize(),
    searchParams,
    getDeploymentExperiments().catch(() => {
      console.error(
        '[Sessions] Failed to load deployment experiments; showing the list view.',
      );
      return { sessionStatusJudgment: false, sessionsBoard: false };
    }),
  ]);
  if (!authorizedUser.success) {
    notFound();
  }
  const { before, user, period, q } = params;
  const boardEnabled = experiments.sessionsBoard;
  const view = boardEnabled && params.view === 'board' ? 'board' : 'list';
  const scope = ['all', 'tasks', 'reviews', 'automations'].includes(
    params.scope ?? '',
  )
    ? (params.scope as SessionScope)
    : 'all';
  const status = (SESSION_STATUSES as readonly string[]).includes(
    params.status ?? '',
  )
    ? (params.status as SessionStatus)
    : undefined;
  const timePeriod = parseTimePeriodParam(period ?? null, 'all');
  const [result, sources] = await Promise.all([
    getSessions(authorizedUser, {
      before,
      user,
      period: timePeriod,
      scope,
      status,
      q,
      repository: params.repository,
      pullRequest: params.pullRequest,
      source: params.source,
      model: params.model,
      includeJudgedStatus: boardEnabled && experiments.sessionStatusJudgment,
    }),
    getSessionSources(authorizedUser),
  ]);
  const boardColumns =
    view === 'board'
      ? SESSION_BOARD_COLUMNS.map((column) => ({
          column,
          sessions: result.sessions.filter(
            (session) =>
              getSessionBoardColumn({
                cachedStatus: session.cachedStatus ?? null,
                judgmentStatus: experiments.sessionStatusJudgment
                  ? session.judgedStatus
                  : null,
              }) === column,
          ),
        })).filter(({ sessions }) => sessions.length > 0)
      : [];
  const olderParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && key !== 'before' && key !== 'view')
      olderParams.set(key, value);
  });
  if (boardEnabled && view === 'board') olderParams.set('view', 'board');
  if (result.nextCursor) olderParams.set('before', result.nextCursor);

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col bg-card">
      <div className="border-b-4 border-b-card bg-background p-4">
        <SessionsFilters
          userId={user ?? null}
          timePeriod={timePeriod}
          scope={scope}
          status={status ?? 'all'}
          view={view}
          boardEnabled={boardEnabled}
          query={q ?? ''}
          repository={params.repository ?? null}
          pullRequest={params.pullRequest ?? null}
          source={params.source ?? 'all'}
          sourceOptions={sources}
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
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-4">
            {boardColumns.map(({ column, sessions: columnSessions }) => {
              return (
                <section
                  key={column}
                  aria-labelledby={`session-board-${column}`}
                  className="min-w-0"
                >
                  <header className="mb-2 flex cursor-default items-center justify-between gap-2">
                    <h2
                      id={`session-board-${column}`}
                      className="text-sm font-medium capitalize"
                    >
                      {getSessionStatusLabel(column)}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {columnSessions.length}
                    </span>
                  </header>
                  <div className="divide-y-2 divide-background bg-card">
                    {columnSessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        viewerUserId={authorizedUser.userId}
                        query={q}
                        hideBlockedBadge
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="divide-y divide-card">
            {result.sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                viewerUserId={authorizedUser.userId}
                query={q}
              />
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

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  getSessionStatusLabel,
  SESSION_STATUSES,
  type SessionStatus,
} from '@roomote/types';

import { parseTimePeriodParam } from '@/types';
import { authorize } from '@/lib/server/auth-context';
import { getSessions, type SessionScope } from '@/lib/server/sessions';
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
} from '@/components/system';
import {
  WorkListBoard,
  WorkListBoardColumn,
  WorkListPage,
  WorkListRows,
} from '@/components/work-list';

import { SessionsFilters } from './SessionsFilters';
import { SessionCard } from './SessionCard';

const SESSION_COLUMN_CONFIG: Record<
  SessionStatus,
  { description: string; dotClassName: string }
> = {
  active: {
    description: 'In progress now',
    dotClassName: 'bg-emerald-500',
  },
  needs_input: {
    description: 'Waiting for a response',
    dotClassName: 'bg-amber-500',
  },
  blocked: {
    description: 'Needs follow-up',
    dotClassName: 'bg-red-500',
  },
  ready: {
    description: 'Ready for more work',
    dotClassName: 'bg-slate-400',
  },
};

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
  const [authorizedUser, params = {}] = await Promise.all([
    authorize(),
    searchParams,
  ]);
  if (!authorizedUser.success) {
    notFound();
  }
  const { before, user, period, q } = params;
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
  const view = params.view === 'board' ? 'board' : 'list';

  const timePeriod = parseTimePeriodParam(period ?? null, 'all');
  const result = await getSessions(authorizedUser, {
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
  });
  const olderParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && key !== 'before') olderParams.set(key, value);
  });
  if (result.nextCursor) olderParams.set('before', result.nextCursor);
  const columns = SESSION_STATUSES;

  return (
    <WorkListPage
      toolbar={
        <SessionsFilters
          userId={user ?? null}
          timePeriod={timePeriod}
          scope={scope}
          status={status ?? 'all'}
          view={view}
          query={q ?? ''}
          repository={params.repository ?? null}
          pullRequest={params.pullRequest ?? null}
          source={params.source ?? 'all'}
          model={params.model ?? null}
        />
      }
    >
      {result.sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>No sessions found.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : view === 'board' ? (
        <WorkListBoard>
          {columns.map((column) => {
            const sessions = result.sessions.filter((session) =>
              column === 'ready'
                ? !session.cachedStatus || session.cachedStatus === column
                : session.cachedStatus === column,
            );
            const config = SESSION_COLUMN_CONFIG[column];

            return (
              <WorkListBoardColumn
                key={column}
                id={`session-${column}`}
                label={getSessionStatusLabel(column)}
                description={config.description}
                count={sessions.length}
                dotClassName={config.dotClassName}
                empty={sessions.length === 0}
              >
                {sessions.map((session) => (
                  <SessionCard key={session.id} session={session} query={q} />
                ))}
              </WorkListBoardColumn>
            );
          })}
        </WorkListBoard>
      ) : (
        <WorkListRows>
          {result.sessions.map((session) => (
            <SessionCard key={session.id} session={session} query={q} />
          ))}
        </WorkListRows>
      )}
      {result.nextCursor ? (
        <div className="flex justify-center p-4">
          <Button asChild variant="outline">
            <Link href={`/sessions?${olderParams.toString()}`}>
              Show older sessions
            </Link>
          </Button>
        </div>
      ) : null}
    </WorkListPage>
  );
}

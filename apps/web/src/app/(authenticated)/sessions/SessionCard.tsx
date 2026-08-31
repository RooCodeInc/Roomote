import { getUserDisplayName } from '@/lib';
import { Avatar } from '@/components/system';
import { WorkspaceBadge } from '@/components/sandbox';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import { SessionSearchSnippet } from '@/components/sessions/SessionSearchSnippet';
import { getSessionSurfaceLabel } from '@/components/sessions/session-surfaces';
import { WorkListInferenceCost, WorkListRow } from '@/components/work-list';

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
  searchSnippet?: string | null;
  tasks: Array<{
    taskId: string;
    workflow: string;
    repositoryName: string | null;
  }>;
};

export function SessionCard({
  session,
  query = '',
}: {
  session: SessionCardData;
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
    <WorkListRow
      href={`/sessions/${session.id}`}
      ariaLabel={`Open session: ${session.title}`}
      leading={
        <div className="relative">
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
      }
      actor={owner}
      activityLabel="started a session"
      activityDate={new Date(session.activityAt * 1000)}
      title={session.title}
      description={
        session.searchSnippet ? (
          <SessionSearchSnippet
            snippet={session.searchSnippet}
            query={query}
            className="line-clamp-2"
          />
        ) : undefined
      }
      metadata={
        <>
          <SessionStatusBadge status={status} />
          <span>{getSessionSurfaceLabel(session.sourceSurface)}</span>
          <WorkspaceBadge repo={primaryTask?.repositoryName ?? undefined} />
          {session.executionCount > 0 ? (
            <span>
              {session.executionCount} execution
              {session.executionCount === 1 ? '' : 's'}
            </span>
          ) : null}
          <WorkListInferenceCost costMicroUsd={session.inferenceCostMicroUsd} />
        </>
      }
      nativeLink
    />
  );
}

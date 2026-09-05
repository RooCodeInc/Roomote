import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost, getUserDisplayName } from '@/lib';
import { formatAutomationLabel } from '@/lib/task-creator-filter';
import {
  Avatar,
  DollarSign,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import { PullRequestBadge } from '@/components/sandbox';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import { SessionSearchSnippet } from '@/components/sessions/SessionSearchSnippet';
import { getSessionSurfaceLabel } from '@/components/sessions/session-surfaces';
import { SessionInferenceCostBreakdown } from '@/components/sessions/SessionInferenceCostBreakdown';
import { TaskAutomationIcon } from '@/components/tasks/TaskAutomationIcon';

type SessionCardData = {
  id: string;
  title: string;
  ownerKind: 'user' | 'automation' | 'system';
  ownerAutomation: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  ownerUserId: string | null;
  sourceSurface: string;
  activityAt: number;
  cachedStatus: 'active' | 'needs_input' | 'blocked' | 'ready' | null;
  executionCount: number;
  inferenceCostMicroUsd: number;
  directInferenceCostMicroUsd: number;
  unread: boolean;
  searchSnippet?: string | null;
  pullRequests: Array<{
    repository: string;
    number: number;
    url: string;
  }>;
  tasks: Array<{
    taskId: string;
    title: string;
    workflow: string;
    repositoryName: string | null;
    inferenceCostMicroUsd: number;
  }>;
};

export function SessionCard({
  session,
  viewerUserId,
  query = '',
  view = 'list',
}: {
  session: SessionCardData;
  viewerUserId: string;
  query?: string;
  view?: 'list' | 'board';
}) {
  const actorName =
    session.ownerKind === 'automation' && session.ownerAutomation
      ? formatAutomationLabel(session.ownerAutomation)
      : (getUserDisplayName({
          name: session.ownerName,
          email: session.ownerEmail,
        }) ?? 'Roomote');
  const status = session.cachedStatus ?? 'ready';

  return (
    <div className="ph-no-capture group relative flex w-full items-start gap-3 p-4 transition-colors hover:bg-accent-foreground/10">
      <Link
        href={`/sessions/${session.id}`}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="sr-only">{session.title}</span>
      </Link>
      <div className="pointer-events-none relative z-10 mt-1 shrink-0">
        {session.ownerKind === 'automation' ? (
          <span
            className="flex size-8 items-center justify-center overflow-clip rounded-full border border-border bg-white dark:bg-muted"
            aria-label={actorName}
          >
            <TaskAutomationIcon
              automationKey={session.ownerAutomation}
              className="size-7"
            />
          </span>
        ) : (
          <Avatar
            imageUrl={session.ownerImageUrl}
            name={actorName}
            email={session.ownerEmail ?? undefined}
            size="md"
            alt={actorName}
          />
        )}
        {session.unread && session.ownerUserId === viewerUserId ? (
          <span
            aria-label="Unread activity"
            className="absolute top-0 right-0 size-2 rounded-full bg-accent-foreground ring-2 ring-background"
          />
        ) : null}
      </div>
      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground/75 md:items-center">
          <div className="flex flex-wrap items-center gap-1 text-nowrap">
            <span>{actorName}</span>
            {view === 'list' ? <span>started a session</span> : null}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(session.activityAt * 1000), {
              addSuffix: true,
            })}
          </span>
        </div>
        <p className="mt-1 mb-2 line-clamp-2 text-base font-medium group-hover:underline">
          {session.title}
        </p>
        <SessionSearchSnippet
          snippet={session.searchSnippet}
          query={query}
          className="line-clamp-2"
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {status === 'active' || status === 'ready' ? null : (
            <SessionStatusBadge status={status} className="capitalize" />
          )}
          {view === 'list' ? (
            <span>{getSessionSurfaceLabel(session.sourceSurface)}</span>
          ) : null}
          {session.pullRequests.map((pullRequest) => (
            <PullRequestBadge
              key={`${pullRequest.repository}:${pullRequest.number}`}
              repo={pullRequest.repository}
              prNumber={pullRequest.number}
              url={pullRequest.url}
              className="pointer-events-auto"
              iconClassName="size-3"
            />
          ))}
          {session.inferenceCostMicroUsd > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="pointer-events-auto relative z-20 inline-flex cursor-default items-center gap-1">
                  <DollarSign className="size-3" />
                  {formatInferenceCost(session.inferenceCostMicroUsd)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="p-3">
                <SessionInferenceCostBreakdown
                  breakdown={{
                    directInferenceCostMicroUsd:
                      session.directInferenceCostMicroUsd,
                    tasks: session.tasks,
                  }}
                  totalInferenceCostMicroUsd={session.inferenceCostMicroUsd}
                />
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

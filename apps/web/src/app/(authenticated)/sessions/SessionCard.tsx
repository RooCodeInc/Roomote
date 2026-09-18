import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost, getUserDisplayName } from '@/lib';
import {
  getSessionArtifactsViewUrl,
  getSessionArtifactViewUrl,
  getSessionTaskArtifactViewUrl,
} from '@/lib/artifact-view-urls';
import { formatAutomationLabel } from '@/lib/task-creator-filter';
import {
  Avatar,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import { ArtifactsBadge, PullRequestBadge } from '@/components/sandbox';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import { SessionSearchSnippet } from '@/components/sessions/SessionSearchSnippet';
import { SessionInferenceCostBreakdown } from '@/components/sessions/SessionInferenceCostBreakdown';
import { PrivateSessionIcon } from '@/components/sessions/PrivateSessionIcon';
import { getSessionSurfaceLabel } from '@/components/sessions/session-surfaces';
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
  privacy: 'shared' | 'private';
  sourceSurface: string;
  activityAt: number;
  cachedStatus: 'active' | 'needs_input' | 'blocked' | 'ready' | null;
  executionCount: number;
  inferenceCostMicroUsd: number;
  directInferenceCostMicroUsd: number;
  unread: boolean;
  artifactCount: number;
  singleArtifact: {
    taskId: string | null;
    path: string;
    version: number;
  } | null;
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
}: {
  session: SessionCardData;
  viewerUserId: string;
  query?: string;
}) {
  const ownerDisplayName =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Roomote';
  const actorName =
    session.ownerKind === 'automation' && session.ownerAutomation
      ? formatAutomationLabel(session.ownerAutomation)
      : ownerDisplayName;
  const status = session.cachedStatus ?? 'ready';
  const surfaceLabel = getSessionSurfaceLabel(session.sourceSurface);
  const hasOutputMetadata =
    session.pullRequests.length > 0 || session.artifactCount > 0;
  const artifactHref = session.singleArtifact
    ? session.singleArtifact.taskId
      ? getSessionTaskArtifactViewUrl(
          '',
          session.id,
          session.singleArtifact.taskId,
          session.singleArtifact.path,
          session.singleArtifact.version,
        )
      : getSessionArtifactViewUrl(
          '',
          session.id,
          session.singleArtifact.path,
          session.singleArtifact.version,
        )
    : getSessionArtifactsViewUrl('', session.id);

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
            name={ownerDisplayName}
            email={session.ownerEmail ?? undefined}
            size="md"
            alt={ownerDisplayName}
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {session.privacy === 'private' ? <PrivateSessionIcon /> : null}
            <span className="truncate">
              {actorName} from {surfaceLabel}
            </span>
            {session.inferenceCostMicroUsd > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="pointer-events-auto relative z-20 inline-flex cursor-default items-center before:mr-1.5 before:content-['·']">
                    ${formatInferenceCost(session.inferenceCostMicroUsd)}
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
            {status === 'active' || status === 'ready' ? null : (
              <SessionStatusBadge status={status} className="capitalize" />
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(session.activityAt * 1000), {
              addSuffix: true,
            })}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 wrap-anywhere text-base font-medium group-hover:underline">
          {session.title}
        </p>
        <SessionSearchSnippet
          snippet={session.searchSnippet}
          query={query}
          className="line-clamp-2 wrap-anywhere"
        />
        {hasOutputMetadata ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {session.pullRequests.map((pullRequest) => (
              <PullRequestBadge
                key={`${pullRequest.repository}:${pullRequest.number}`}
                repo={pullRequest.repository}
                prNumber={pullRequest.number}
                url={pullRequest.url}
                className="pointer-events-auto min-w-0 max-w-full"
                iconClassName="size-3"
              />
            ))}
            {session.artifactCount > 0 ? (
              <ArtifactsBadge
                count={session.artifactCount}
                href={artifactHref}
                className="pointer-events-auto min-w-0 max-w-full"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

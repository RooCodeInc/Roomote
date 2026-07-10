import { useState } from 'react';
import Link from 'next/link';

import {
  isActivelyRunningTask,
  isBootingRunStatus,
  type RunStatus,
} from '@roomote/types';

import {
  PullRequestBadge,
  TaskStatusIndicator,
  WorkspaceBadge,
} from '@/components/sandbox';
import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  MessageSquareText,
  Pin,
  Spinner,
} from '@/components/system';
import { cn } from '@/lib/utils';

type SideNavQuickAccessTask = {
  id: string;
  title: string | null;
  taskRun: {
    status: RunStatus;
    taskPhase: string | null;
    prRepo?: string | null;
    prNumber?: number | null;
    payload?: {
      environmentId?: string | null;
      repo?: string | null;
    } | null;
  };
};

type SideNavTaskItemProps = {
  task: SideNavQuickAccessTask;
  liveStatus?: {
    phase: string | null;
    lastErrorMessage: string | undefined;
  } | null;
  isActive: boolean;
  isPinned: boolean;
  isPinPending: boolean;
  onTogglePin: (nextPinned: boolean) => void;
  expanded?: boolean;
};

function getMissingEnvironmentLabel(environmentId: string): string {
  return `Environment ${environmentId.slice(0, 8)}`;
}

export const SideNavTaskItem = ({
  task,
  liveStatus,
  isActive,
  isPinned,
  isPinPending,
  onTogglePin,
  expanded = false,
}: SideNavTaskItemProps) => {
  const [isExpandedRowActionVisible, setIsExpandedRowActionVisible] =
    useState(false);
  const environmentId = task.taskRun?.payload?.environmentId ?? undefined;
  const environmentFallbackLabel = environmentId
    ? getMissingEnvironmentLabel(environmentId)
    : undefined;
  const taskTitle = task.title ?? 'Untitled task';
  const hasLiveStatus =
    liveStatus?.phase != null || Boolean(liveStatus?.lastErrorMessage);
  const isTaskStartingUp =
    !hasLiveStatus && isBootingRunStatus(task.taskRun.status);
  const taskPhase = hasLiveStatus
    ? (liveStatus?.phase ?? null)
    : task.taskRun.taskPhase;
  const taskStatus = hasLiveStatus ? undefined : task.taskRun.status;
  const showsExpandedSpinner = hasLiveStatus
    ? taskPhase === 'running'
    : isActivelyRunningTask(task.taskRun.status, taskPhase);

  if (expanded) {
    return (
      <HoverCard openDelay={120} closeDelay={180}>
        <HoverCardTrigger asChild>
          <div
            className="relative w-full"
            onPointerOver={() => setIsExpandedRowActionVisible(true)}
            onPointerOut={(event) => {
              const nextTarget = event.relatedTarget as Node | null;

              if (!event.currentTarget.contains(nextTarget)) {
                setIsExpandedRowActionVisible(false);
              }
            }}
            onFocus={() => setIsExpandedRowActionVisible(true)}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;

              if (!event.currentTarget.contains(nextTarget)) {
                setIsExpandedRowActionVisible(false);
              }
            }}
          >
            <Link
              href={`/task/${task.id}`}
              aria-label={taskTitle}
              className={cn(
                'flex min-h-10 w-full items-center rounded-lg px-4 py-2 transition-colors',
                showsExpandedSpinner && 'gap-2',
                isActive
                  ? 'bg-foreground text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
                  : 'text-muted-foreground hover:text-accent-foreground',
              )}
            >
              {showsExpandedSpinner ? (
                <Spinner className="size-4 shrink-0 animate-spin" />
              ) : null}
              <span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium leading-5 wrap-break-word">
                {taskTitle}
              </span>
            </Link>

            <div
              data-task-pin-overlay
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center rounded-r-2xl pr-1 pl-8 opacity-0 transition-opacity duration-150',
                isExpandedRowActionVisible && 'opacity-100',
                isActive
                  ? 'bg-gradient-to-l from-foreground via-foreground/95 to-transparent dark:from-accent-foreground dark:via-accent-foreground/95'
                  : 'bg-gradient-to-l from-card via-card/95 to-transparent',
              )}
            >
              <span className="size-7" />
            </div>

            <Button
              data-task-pin
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'pointer-events-none absolute top-1/2 right-2 z-20 flex size-7 -translate-y-1/2 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 focus-visible:!pointer-events-auto focus-visible:!opacity-100',
                isExpandedRowActionVisible && 'pointer-events-auto opacity-100',
                isActive
                  ? 'bg-card hover:bg-accent-foreground text-foreground dark:bg-background dark:text-foreground dark:hover:text-accent-bright-foreground'
                  : 'text-muted-foreground',
                isExpandedRowActionVisible &&
                  !isActive &&
                  'text-accent-foreground',
                isPinned && 'text-accent-foreground',
              )}
              aria-label={isPinned ? 'Unpin task' : 'Pin task'}
              aria-pressed={isPinned}
              disabled={isPinPending}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin(!isPinned);
              }}
            >
              <Pin className="size-3.5" />
            </Button>
          </div>
        </HoverCardTrigger>

        <HoverCardContent
          side="right"
          align="start"
          sideOffset={8}
          className="-ml-1 w-fit max-w-72 rounded-xl px-2.5 py-2"
        >
          <div className="space-y-2">
            <p className="text-sm font-medium wrap-break-word">{taskTitle}</p>

            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {environmentId ? (
                <WorkspaceBadge
                  environmentId={environmentId}
                  fallbackLabel={environmentFallbackLabel}
                  className="max-w-full text-xs"
                  iconClassName="size-3.5 text-muted-foreground"
                />
              ) : null}

              {task.taskRun?.prRepo && task.taskRun?.prNumber ? (
                <PullRequestBadge
                  repo={task.taskRun.prRepo}
                  prNumber={task.taskRun.prNumber}
                  className="max-w-40"
                  iconClassName="size-3.5 text-muted-foreground"
                />
              ) : null}
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <HoverCard openDelay={120} closeDelay={180}>
      <HoverCardTrigger asChild>
        <Link
          href={`/task/${task.id}`}
          aria-label={taskTitle}
          className={cn(
            'group relative flex size-11 items-center justify-center',
            isActive ? 'text-accent-foreground' : 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'relative flex size-10 items-center justify-center rounded-full transition-all',
              'group-hover:bg-accent group-hover:text-accent-foreground group-hover:scale-110',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground',
            )}
          >
            {isTaskStartingUp ? (
              <Spinner className="size-4 animate-spin" />
            ) : (
              <MessageSquareText className="size-4" />
            )}
            {!isTaskStartingUp && (
              <TaskStatusIndicator
                compact
                status={taskStatus}
                phase={taskPhase}
                lastErrorMessage={
                  hasLiveStatus ? liveStatus?.lastErrorMessage : undefined
                }
                className="pointer-events-none absolute right-[6px] bottom-[6px] z-10"
              />
            )}
          </span>
        </Link>
      </HoverCardTrigger>

      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="-ml-1 w-80 rounded-xl p-3"
      >
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'mt-0.5 size-7 shrink-0',
              isPinned && 'text-accent-foreground',
            )}
            aria-label={isPinned ? 'Unpin task' : 'Pin task'}
            aria-pressed={isPinned}
            disabled={isPinPending}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTogglePin(!isPinned);
            }}
          >
            <Pin className="-translate-y-1 size-3 rotate-45" />
          </Button>

          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium">{taskTitle}</p>

            {environmentId ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <WorkspaceBadge
                  environmentId={environmentId}
                  fallbackLabel={environmentFallbackLabel}
                  className="max-w-full text-xs"
                  iconClassName="size-3.5 text-muted-foreground"
                />
              </div>
            ) : null}

            {task.taskRun?.prRepo && task.taskRun?.prNumber ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <PullRequestBadge
                  repo={task.taskRun.prRepo}
                  prNumber={task.taskRun.prNumber}
                  className="text-xs! w-full!"
                  iconClassName="size-3.5 text-muted-foreground"
                />
              </div>
            ) : null}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { PRODUCT_NAME } from '@roomote/types';

import type { Task } from '@/lib/server';
import { getUserDisplayName, stripHtmlTags, stripMarkdown } from '@/lib';
import {
  Avatar,
  MessageSquareText,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import { PullRequestBadge, WorkspaceBadge } from '@/components/sandbox';

import { TaskAutomationIcon } from './TaskAutomationIcon';
import { getTaskBoardColumn, type TaskBoardColumn } from './task-board';

const DONE_TASK_LIMIT = 6;

const COLUMN_CONFIG: Array<{
  id: TaskBoardColumn;
  label: string;
  description: string;
  dotClassName: string;
}> = [
  {
    id: 'active',
    label: 'Active',
    description: 'In progress now',
    dotClassName: 'bg-emerald-500',
  },
  {
    id: 'needs-input',
    label: 'Needs input',
    description: 'Waiting for a response',
    dotClassName: 'bg-amber-500',
  },
  {
    id: 'blocked',
    label: 'Blocked / failed',
    description: 'Needs follow-up',
    dotClassName: 'bg-red-500',
  },
  {
    id: 'done',
    label: 'Done',
    description: 'Recently completed',
    dotClassName: 'bg-slate-400',
  },
];

function BoardTaskCard({ task }: { task: Task }) {
  const actorName =
    task.attributionLabel?.trim() ||
    getUserDisplayName(task.user) ||
    PRODUCT_NAME;
  const activityAt = task.activityAt ?? task.timestamp;
  const activityDate = new Date(activityAt * 1000);
  const people = task.user
    ? [task.user, ...task.participants]
    : task.participants;
  const visiblePeople = people.slice(0, 3);
  const hiddenPeopleCount = Math.max(people.length - visiblePeople.length, 0);

  return (
    <div className="ph-no-capture relative cursor-pointer space-y-1.5 bg-card p-4 transition-colors hover:bg-muted/50">
      <Link
        href={`/task/${task.id}`}
        aria-label={`Open task: ${stripMarkdown(stripHtmlTags(task.title))}`}
        className="absolute inset-0 z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground/75">
        <span className="truncate">Started by {actorName}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <time
              dateTime={activityDate.toISOString()}
              className="relative z-20 shrink-0"
            >
              {formatDistanceToNow(activityDate, { addSuffix: true })}
            </time>
          </TooltipTrigger>
          <TooltipContent>{activityDate.toLocaleString()}</TooltipContent>
        </Tooltip>
      </div>
      <div className="text-base font-semibold leading-snug -mt-1">
        {stripMarkdown(stripHtmlTags(task.title))}
      </div>
      {getTaskBoardColumn(task) === 'blocked' && task.goalBlockedReason && (
        <p className="line-clamp-2 text-xs text-destructive">
          {task.goalBlockedReason}
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {(task.taskRun.payload.environmentId ||
          task.taskRun.payload.repo ||
          task.repositoryName ||
          task.taskRun.prRepo) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <WorkspaceBadge
              environmentId={task.taskRun.payload.environmentId}
              repo={
                task.taskRun.payload.repo ?? task.repositoryName ?? undefined
              }
              iconClassName="size-3"
            />
            {task.taskRun.prRepo && task.taskRun.prNumber && (
              <PullRequestBadge
                repo={task.taskRun.prRepo}
                prNumber={task.taskRun.prNumber}
                className="relative z-20"
                iconClassName="size-3"
              />
            )}
          </div>
        )}
        <div
          className="relative z-20 ml-auto flex shrink-0 items-center -space-x-2"
          aria-label={`${people.length || 1} task participant${people.length === 1 ? '' : 's'}`}
        >
          {visiblePeople.map((person) => {
            const displayName = getUserDisplayName(person) ?? person.email;

            return (
              <Tooltip key={person.id}>
                <TooltipTrigger asChild>
                  <Avatar
                    imageUrl={person.imageUrl}
                    name={person.name}
                    email={person.email}
                    size="sm"
                    className="ring-2 ring-card"
                    alt={displayName}
                  />
                </TooltipTrigger>
                <TooltipContent>{displayName}</TooltipContent>
              </Tooltip>
            );
          })}
          {visiblePeople.length === 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex size-6 items-center justify-center rounded-full border border-border bg-muted ring-2 ring-card">
                  {task.attributionKind === 'automation' ? (
                    <TaskAutomationIcon
                      automationKey={task.initiatorAutomation}
                      className="size-3 text-muted-foreground"
                    />
                  ) : (
                    <MessageSquareText className="size-3 text-muted-foreground" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent>{actorName}</TooltipContent>
            </Tooltip>
          )}
          {hiddenPeopleCount > 0 && (
            <span className="flex size-6 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-medium ring-2 ring-card">
              +{hiddenPeopleCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  const groupedTasks = new Map<TaskBoardColumn, Task[]>(
    COLUMN_CONFIG.map((column) => [column.id, []]),
  );

  for (const task of tasks) {
    groupedTasks.get(getTaskBoardColumn(task))?.push(task);
  }

  const doneTasks = groupedTasks.get('done') ?? [];
  const hiddenDoneCount = Math.max(doneTasks.length - DONE_TASK_LIMIT, 0);

  return (
    <div className="grid min-w-0 grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 lg:px-2">
      {COLUMN_CONFIG.map((column) => {
        const columnTasks = groupedTasks.get(column.id) ?? [];
        const visibleTasks =
          column.id === 'done'
            ? columnTasks.slice(0, DONE_TASK_LIMIT)
            : columnTasks;

        return (
          <section
            key={column.id}
            aria-labelledby={`task-board-${column.id}`}
            className="min-w-0 py-2"
          >
            <header className="mb-3 flex items-start justify-between gap-3">
              <div className="space-y-0 pl-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${column.dotClassName}`}
                  />
                  <h2
                    id={`task-board-${column.id}`}
                    className="text-sm font-semibold"
                  >
                    {column.label}
                    <span className="text-sm text-muted-foreground/50 ml-1">
                      {columnTasks.length}
                    </span>
                  </h2>
                </div>
                <p className="text-xs text-muted-foreground pl-4">
                  {column.description}
                </p>
              </div>
              <span className="rounded-full text-xs text-muted-foreground"></span>
            </header>

            <div className="divide-y-2 divide-background px-1 [&>div]:first:rounded-t-xl [&>div]:last:rounded-b-xl">
              {visibleTasks.length > 0 ? (
                visibleTasks.map((task) => (
                  <BoardTaskCard key={task.id} task={task} />
                ))
              ) : (
                <div className="pl-4 text-xs text-muted-foreground/50">
                  Empty
                </div>
              )}
            </div>

            {column.id === 'done' && hiddenDoneCount > 0 && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {hiddenDoneCount} older completed task
                {hiddenDoneCount === 1 ? '' : 's'} hidden
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function TaskBoardSkeleton() {
  return (
    <div className="grid w-full grid-cols-1 divide-y-2 divide-card lg:grid-cols-2 lg:divide-x-2 lg:divide-y-0 lg:max-xl:[&>div:nth-child(odd)]:!border-l-0 xl:grid-cols-4">
      {COLUMN_CONFIG.map((column) => (
        <div key={column.id} className="space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="size-6 rounded-full" />
          </div>
          <Skeleton className="h-36 w-full rounded-lg" />
          <Skeleton className="h-36 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

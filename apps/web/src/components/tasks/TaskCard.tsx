import { isActivelyRunningTask, PRODUCT_NAME } from '@roomote/types';

import type { Task } from '@/lib/server';
import { getUserDisplayName, stripHtmlTags, stripMarkdown } from '@/lib';
import { cn } from '@/lib/utils';
import type { TaskFilterState } from '@/hooks/tasks';
import {
  Avatar,
  Checkbox,
  FileText,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import {
  ModelBadge,
  PullRequestBadge,
  WorkspaceBadge,
} from '@/components/sandbox';
import { WorkListInferenceCost, WorkListRow } from '@/components/work-list';

import { TaskAutomationIcon } from './TaskAutomationIcon';

type TaskCardProps = {
  task: Task;
  filterState: Pick<TaskFilterState, 'hasSpecificUserFilter'>;
  isSelected?: boolean;
  inSelectionMode?: boolean;
  onSelectionChange?: (taskId: string, selected: boolean) => void;
};

export const TaskCard = ({
  task,
  filterState: _filterState,
  isSelected = false,
  inSelectionMode = false,
  onSelectionChange,
}: TaskCardProps) => {
  const hasUser = task.user !== null;
  const userDisplayName = getUserDisplayName(task.user) ?? PRODUCT_NAME;
  const actorName =
    task.attributionLabel?.trim() ||
    getUserDisplayName(task.user) ||
    PRODUCT_NAME;
  const activityAt = task.activityAt ?? task.timestamp;
  const activityDate = new Date(activityAt * 1000);
  const title = stripMarkdown(stripHtmlTags(task.title));

  return (
    <WorkListRow
      href={`/task/${task.id}`}
      ariaLabel={`Open task: ${title}`}
      leading={
        <div className="flex items-center -space-x-2.5">
          {hasUser && task.user ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Avatar
                  imageUrl={task.user.imageUrl}
                  name={userDisplayName}
                  email={task.user.email}
                  size="md"
                  className="ring-1 ring-background"
                  alt={userDisplayName}
                />
              </TooltipTrigger>
              <TooltipContent>{userDisplayName}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex size-8 items-center justify-center rounded-full border border-border bg-muted ring-1 ring-background">
                  {task.attributionKind === 'automation' ? (
                    <TaskAutomationIcon
                      automationKey={task.initiatorAutomation}
                      className="size-4 text-muted-foreground"
                    />
                  ) : (
                    <FileText className="size-4 text-muted-foreground" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>{actorName}</TooltipContent>
            </Tooltip>
          )}
        </div>
      }
      leadingOverlay={
        onSelectionChange ? (
          <div
            className={cn(
              'absolute inset-y-0 left-2 right-2 z-10 flex items-center justify-center rounded-full bg-primary transition-transform',
              inSelectionMode
                ? 'scale-100 opacity-100'
                : 'pointer-events-none scale-0 opacity-0',
            )}
            onClick={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => {
                if (typeof checked === 'boolean') {
                  onSelectionChange(task.id, checked);
                }
              }}
              className="cursor-pointer"
              aria-label={`Select task ${task.title}`}
            />
          </div>
        ) : undefined
      }
      actor={actorName}
      activityLabel="started a task"
      activityAdornment={
        isActivelyRunningTask(task.taskRun.status, task.taskRun.taskPhase) ? (
          <Spinner className="size-3 animate-spin" />
        ) : undefined
      }
      activityDate={activityDate}
      title={title}
      metadata={
        <>
          <WorkspaceBadge
            environmentId={task.taskRun.payload.environmentId}
            repo={task.taskRun.payload.repo ?? task.repositoryName ?? undefined}
            iconClassName="size-3"
          />
          {task.taskRun.prRepo && task.taskRun.prNumber ? (
            <PullRequestBadge
              repo={task.taskRun.prRepo}
              prNumber={task.taskRun.prNumber}
              className="relative z-20"
              iconClassName="size-3"
            />
          ) : null}
          <ModelBadge
            model={task.model}
            displayName={task.modelDisplayName}
            iconClassName="size-3"
          />
          <WorkListInferenceCost
            costMicroUsd={task.inferenceUsage?.costMicroUsd}
          />
        </>
      }
      selected={isSelected}
      interactive={!inSelectionMode}
    />
  );
};

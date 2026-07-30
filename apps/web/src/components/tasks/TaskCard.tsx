import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';

import { isActivelyRunningTask, PRODUCT_NAME } from '@roomote/types';

import { type Task } from '@/lib/server';
import {
  getUserDisplayName,
  stripHtmlTags,
  stripMarkdown,
  formatInferenceCost,
} from '@/lib';
import { cn } from '@/lib/utils';

import type { TaskFilterState } from '@/hooks/tasks';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Checkbox,
  Spinner,
  FileText,
  DollarSign,
  Avatar,
} from '@/components/system';
import {
  ModelBadge,
  WorkspaceBadge,
  PullRequestBadge,
} from '@/components/sandbox';

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
  const router = useRouter();

  const hasUser = task.user !== null;
  const showUserAvatar = hasUser;
  const showAgentAvatar = !hasUser;
  const userDisplayName = getUserDisplayName(task.user) ?? PRODUCT_NAME;
  const actorName =
    task.attributionLabel?.trim() ||
    getUserDisplayName(task.user) ||
    PRODUCT_NAME;
  const activityAt = task.activityAt ?? task.timestamp;
  const activityDate = new Date(activityAt * 1000);
  const inferenceCostLabel = formatInferenceCost(
    task.inferenceUsage?.costMicroUsd,
  );
  const hasInferenceCost = Number(inferenceCostLabel) > 0;

  return (
    <div
      className={cn(
        'ph-no-capture relative flex items-start gap-3 w-full p-4',
        {
          'bg-foreground/20': isSelected,
          'cursor-pointer transition-colors hover:bg-accent-foreground/10':
            !inSelectionMode,
        },
      )}
      onClick={() => {
        if (!inSelectionMode) {
          router.push(`/task/${task.id}`);
        }
      }}
    >
      {/* Avatars */}
      <div className="relative mt-1 shrink-0 h-8 w-12 flex justify-center">
        <div className="flex items-center -space-x-2.5">
          {showUserAvatar && task.user && (
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
              <TooltipContent>
                <p>{userDisplayName}</p>
              </TooltipContent>
            </Tooltip>
          )}

          {showAgentAvatar && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="size-8 flex items-center justify-center rounded-full border border-border bg-muted ring-1 ring-background">
                  <FileText className="size-4 text-muted-foreground" />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{actorName}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {onSelectionChange && (
          <div
            className={cn(
              'flex items-center justify-center absolute left-2 right-2 top-0 bottom-0 z-10 transition-transform rounded-full bg-primary',
              inSelectionMode
                ? 'scale-100 opacity-100'
                : 'scale-0 opacity-0 pointer-events-none',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => {
                if (typeof checked === 'boolean') {
                  onSelectionChange?.(task.id, checked);
                }
              }}
              className="cursor-pointer"
              aria-label={`Select task ${task.title}`}
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-start md:items-center gap-2 justify-between text-xs text-muted-foreground/75">
          <div className="flex items-center gap-1 text-nowrap flex-wrap">
            <span className="ph-no-capture">{actorName}</span>
            <span>
              <span>started a task</span>
            </span>
            <span>
              {isActivelyRunningTask(
                task.taskRun.status,
                task.taskRun.taskPhase,
              ) && <Spinner className="size-3 animate-spin" />}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default whitespace-nowrap">
                {formatDistanceToNow(activityDate, { addSuffix: true })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{activityDate.toLocaleString()}</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Title */}
        <Link
          href={`/task/${task.id}`}
          className="block group"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="text-lg text-foreground mt-1 mb-2 leading-tight ph-no-capture group-hover:underline line-clamp-2">
            {stripMarkdown(stripHtmlTags(task.title))}
          </p>
        </Link>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs min-w-0 overflow-hidden">
          <WorkspaceBadge
            environmentId={task.taskRun.payload.environmentId}
            repo={task.taskRun.payload.repo ?? task.repositoryName ?? undefined}
            iconClassName="size-3"
          />
          {task.taskRun.prRepo && task.taskRun.prNumber && (
            <PullRequestBadge
              repo={task.taskRun.prRepo}
              prNumber={task.taskRun.prNumber}
              iconClassName="size-3"
            />
          )}
          <ModelBadge
            model={task.model}
            displayName={task.modelDisplayName}
            iconClassName="size-3"
          />
          {hasInferenceCost && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-nowrap cursor-default">
                  <DollarSign className="size-3 shrink-0" />
                  <span>{inferenceCostLabel}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>Inference cost</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};

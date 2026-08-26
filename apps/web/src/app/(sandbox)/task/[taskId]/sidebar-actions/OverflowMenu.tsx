'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Check,
  Loader2,
  Moon,
  MoreVertical,
  Trash2,
} from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import {
  isExitedRunStatus,
  isResumableTaskPayloadKind,
  isTaskExecutingTurn,
  isTaskResumeCapableComputeProvider,
  runningRunStatuses,
} from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import {
  isTaskResolutionActionable,
  useAcknowledgeTaskResolution,
  useDeleteTasks,
} from '@/hooks/tasks';
import { useCancelTaskRun } from '@/hooks/task-runs';
import { useRequestTaskRunSleep } from '@/hooks/snapshots';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/system';

import type { OverflowMenuProps } from './types';
import { isTaskRunAsleep } from './utils';

function OverflowMenuBase({
  taskId,
  taskRun,
  resolutionStatus,
  disabled = false,
  onDeleteSuccess,
}: OverflowMenuProps) {
  const router = useRouter();
  const { user } = useUser();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Task deletion is deployment-wide: any member can delete any task.
  const canShutdown = !!taskRun && !isExitedRunStatus(taskRun.status);
  const canSleep =
    !!taskRun &&
    !!taskRun.machineId &&
    !isExitedRunStatus(taskRun.status) &&
    runningRunStatuses.some((status) => status === taskRun.status) &&
    !isTaskRunAsleep(taskRun) &&
    !taskRun.snapshotFailedAt &&
    isResumableTaskPayloadKind(taskRun.payloadKind) &&
    isTaskResumeCapableComputeProvider(taskRun.vendor);
  const canAcknowledgeResolution =
    isTaskResolutionActionable(resolutionStatus) &&
    !isTaskExecutingTurn(taskRun?.status, taskRun?.taskPhase);

  const deleteTasks = useDeleteTasks({
    onSuccess: () => {
      toast.success('Task deleted successfully.');
      onDeleteSuccess?.();
      router.push('/tasks');
    },
    onError: () => toast.error('Failed to delete task.'),
  });

  const cancelTaskRun = useCancelTaskRun({
    onSuccess: (data) => {
      if (data.success) {
        toast.success('Task shut down request sent.');
      } else {
        toast.error(data.error);
      }
    },
    onError: () => toast.error('Failed to shut down task.'),
  });

  const requestTaskRunSleep = useRequestTaskRunSleep({
    onSuccess: () => {
      toast.success('Task is going to sleep.');
    },
  });
  const acknowledgeResolution = useAcknowledgeTaskResolution();

  if (!user) {
    return null;
  }

  if (disabled) {
    return (
      <SideNavItem side="right" label="More actions" disabled>
        <MoreVertical className="size-5" />
      </SideNavItem>
    );
  }

  const handleSleep = async () => {
    if (!taskRun || requestTaskRunSleep.isPending) {
      return;
    }

    try {
      await requestTaskRunSleep.mutateAsync({ runId: taskRun.id });
    } catch {
      // Errors are toasted by the mutation hook.
    }
  };

  const handleDeleteConfirm = async () => {
    if (canShutdown) {
      const shutdownResult = await cancelTaskRun.mutateAsync({
        taskId,
        runId: taskRun.id,
      });

      if (!shutdownResult.success) {
        return;
      }
    }

    await deleteTasks.mutateAsync({ taskIds: [taskId] });
    setShowDeleteDialog(false);
  };

  const handleMarkDone = async () => {
    try {
      await acknowledgeResolution.mutateAsync({ taskId });
      toast.success('Task marked done.');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to mark task done.',
      );
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SideNavItem side="right" label="More actions" tooltip="More actions">
            <MoreVertical className="size-5" />
          </SideNavItem>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="left">
          {canAcknowledgeResolution ? (
            <DropdownMenuItem
              onClick={() => void handleMarkDone()}
              disabled={acknowledgeResolution.isPending}
              aria-label={
                acknowledgeResolution.isPending
                  ? 'Marking task done'
                  : 'Mark done'
              }
              className="flex cursor-pointer items-center gap-2"
            >
              {acknowledgeResolution.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              {acknowledgeResolution.isPending
                ? 'Marking done...'
                : 'Mark done'}
            </DropdownMenuItem>
          ) : null}
          {canSleep ? (
            <DropdownMenuItem
              onClick={handleSleep}
              disabled={requestTaskRunSleep.isPending}
              className="flex cursor-pointer items-center gap-2"
            >
              <Moon className="size-4" />
              Sleep
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setShowDeleteDialog(true)}
            className="flex cursor-pointer items-center gap-2"
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              {canShutdown
                ? "This will first shut down the task's machine, then permanently delete this task and all its data. This action cannot be undone."
                : 'This will permanently delete this task and all its data. This action cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleteTasks.isPending || cancelTaskRun.isPending}
            >
              {cancelTaskRun.isPending
                ? 'Shutting down...'
                : deleteTasks.isPending
                  ? 'Deleting...'
                  : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const OverflowMenu = memo(OverflowMenuBase);

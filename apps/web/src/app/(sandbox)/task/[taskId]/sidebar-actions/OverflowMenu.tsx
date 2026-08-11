'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeftRight,
  Moon,
  MoreVertical,
  Trash2,
} from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import {
  isExitedRunStatus,
  isResumableTaskPayloadKind,
  isTaskResumeCapableComputeProvider,
  runningRunStatuses,
  TaskPayloadKind,
} from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import { useDeleteTasks } from '@/hooks/tasks';
import { useCancelTaskRun } from '@/hooks/task-runs';
import { useRequestTaskRunSleep } from '@/hooks/snapshots';
import { useAvailableEnvironments } from '@/hooks/environments';
import { useTRPCClient } from '@/trpc/client';

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
  DialogFooter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

import type { OverflowMenuProps } from './types';
import { isTaskRunAsleep } from './utils';

function OverflowMenuBase({
  taskId,
  taskRun,
  disabled = false,
  onDeleteSuccess,
}: OverflowMenuProps) {
  const router = useRouter();
  const { user } = useUser();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);

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
  const currentEnvironmentId = taskRun?.payload?.environmentId;
  const canSwitchWorkspace =
    !!taskRun &&
    canShutdown &&
    taskRun.payloadKind === TaskPayloadKind.StandardTask;

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SideNavItem side="right" label="More actions" tooltip="More actions">
            <MoreVertical className="size-5" />
          </SideNavItem>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="left">
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
          {canSwitchWorkspace ? (
            <DropdownMenuItem
              onClick={() => setShowWorkspaceDialog(true)}
              className="flex cursor-pointer items-center gap-2"
            >
              <ArrowLeftRight className="size-4" />
              Change workspace
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
      {canSwitchWorkspace && showWorkspaceDialog ? (
        <WorkspaceSwitchDialog
          taskId={taskId}
          currentEnvironmentId={currentEnvironmentId}
          open={showWorkspaceDialog}
          onOpenChange={setShowWorkspaceDialog}
        />
      ) : null}
    </>
  );
}

export const OverflowMenu = memo(OverflowMenuBase);

function WorkspaceSwitchDialog({
  taskId,
  currentEnvironmentId,
  open,
  onOpenChange,
}: {
  taskId: string;
  currentEnvironmentId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [targetEnvironmentId, setTargetEnvironmentId] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);
  const environments = useAvailableEnvironments();
  const trpcClient = useTRPCClient();
  const switchTargets = (environments.data ?? []).filter(
    (environment) => environment.id !== currentEnvironmentId,
  );

  const handleSwitch = async () => {
    setIsSwitching(true);
    try {
      const result = await trpcClient.taskWorkspaceTransitions.request.mutate({
        taskId,
        targetEnvironmentId,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      if (result.noop) {
        toast.info('This task already uses that workspace.');
        onOpenChange(false);
        return;
      }
      toast.success('Workspace switch started.');
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Workspace switch failed.',
      );
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Change workspace</DialogTitle>
          <DialogDescription>
            Roomote will verify that all current work is committed and pushed,
            shut down this runtime, then continue the same task in a fresh
            runtime and session.
          </DialogDescription>
        </DialogHeader>
        <Select
          value={targetEnvironmentId}
          onValueChange={setTargetEnvironmentId}
        >
          <SelectTrigger aria-label="Target workspace" className="w-full">
            <SelectValue placeholder="Select a verified workspace" />
          </SelectTrigger>
          <SelectContent>
            {switchTargets.map((environment) => (
              <SelectItem key={environment.id} value={environment.id}>
                {environment.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSwitching}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSwitch}
            disabled={!targetEnvironmentId || isSwitching}
          >
            {isSwitching ? 'Checking workspace…' : 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

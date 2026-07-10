'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MoreVertical, Trash2 } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import { isExitedCloudTaskStatus } from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import { useDeleteTasks } from '@/hooks/tasks';
import { useCancelCloudJob } from '@/hooks/cloud-jobs';

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

function OverflowMenuBase({
  taskId,
  cloudJob,
  disabled = false,
  onDeleteSuccess,
}: OverflowMenuProps) {
  const router = useRouter();
  const { user } = useUser();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Task deletion is deployment-wide: any member can delete any task.
  const canShutdown = !!cloudJob && !isExitedCloudTaskStatus(cloudJob.status);

  const deleteTasks = useDeleteTasks({
    onSuccess: () => {
      toast.success('Task deleted successfully.');
      onDeleteSuccess?.();
      router.push('/tasks');
    },
    onError: () => toast.error('Failed to delete task.'),
  });

  const cancelCloudJob = useCancelCloudJob({
    onSuccess: (data) => {
      if (data.success) {
        toast.success('Task shut down request sent.');
      } else {
        toast.error(data.error);
      }
    },
    onError: () => toast.error('Failed to shut down task.'),
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

  const handleDeleteConfirm = async () => {
    if (canShutdown) {
      const shutdownResult = await cancelCloudJob.mutateAsync({
        taskId,
        cloudJobId: cloudJob.id,
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
              disabled={deleteTasks.isPending || cancelCloudJob.isPending}
            >
              {cancelCloudJob.isPending
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

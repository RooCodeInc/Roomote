'use client';

import { useState, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getSessionStatusLabel,
  SESSION_MANUAL_STATUSES,
  type SessionManualStatus,
  type SessionStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { announceSessionBoardMove } from '@/components/sessions/session-board-motion';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  Activity,
  Archive,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  MoreVertical,
  Square,
  Trash2,
} from '@/components/system';

export const SESSION_DELETION_DESCRIPTION =
  'This first stops active tasks, then permanently deletes the session, its associated tasks and artifacts, and Brain memories saved directly from them. It does not remove independently collected Slack or pull request content, broader summaries, or every reference elsewhere. This action cannot be undone.';

export function SessionActions({
  sessionId,
  listRow = false,
  status,
  sessionStatusExperimentEnabled = false,
}: {
  sessionId: string;
  listRow?: boolean;
  status?: SessionStatus | SessionManualStatus | null;
  sessionStatusExperimentEnabled?: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const currentStatus = status ?? 'ready';
  const stopTasks = useMutation(
    trpc.sessions.stopTasks.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          toast.success(
            result.stoppedCount === 0
              ? 'No active tasks to stop.'
              : result.stoppedCount === 1
                ? 'Stopped 1 task.'
                : `Stopped ${result.stoppedCount} tasks.`,
          );
          router.refresh();
        } else {
          toast.error('Some active tasks could not be stopped. Try again.');
        }
      },
      onError: () => toast.error('Failed to stop tasks.'),
    }),
  );
  const archiveSession = useMutation(
    trpc.sessions.archive.mutationOptions({
      onSuccess: (result) => {
        if (!result) {
          toast.error('Failed to archive session.');
          return;
        }
        toast.success('Session archived.');
        if (!listRow) router.push('/sessions');
        router.refresh();
      },
      onError: (error) =>
        toast.error(error.message || 'Failed to archive session.'),
    }),
  );
  const deleteSession = useMutation(
    trpc.sessions.delete.mutationOptions({
      onSuccess: (result) => {
        if (result.deleted) {
          toast.success('Session deleted.');
          router.push('/');
          router.refresh();
          return;
        }

        if (
          result.reason === 'stop_failed' ||
          result.reason === 'session_busy'
        ) {
          toast.error('Active work could not be stopped. Try again shortly.');
        } else if (result.reason === 'artifact_uploads_pending') {
          toast.error(
            'Artifact uploads are still finishing. Try again shortly.',
          );
        } else {
          toast.error('Failed to delete session.');
        }
      },
      onError: () => toast.error('Failed to delete session.'),
    }),
  );
  const setStatus = useMutation(
    trpc.sessions.setStatus.mutationOptions({
      onSuccess: (result, variables) => {
        if (!result) {
          toast.error('Failed to update session status.');
          return;
        }
        const nextStatus = (variables as { status: SessionManualStatus })
          .status;
        announceSessionBoardMove(sessionId, nextStatus);
        toast.success(
          `Session marked as ${getSessionStatusLabel(nextStatus)}.`,
        );
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.byId.queryKey({ sessionId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.search.queryKey(),
        });
        router.refresh();
      },
      onError: (error) =>
        toast.error(error.message || 'Failed to update session status.'),
    }),
  );
  const isPending =
    stopTasks.isPending ||
    archiveSession.isPending ||
    deleteSession.isPending ||
    setStatus.isPending;
  const stopPropagation = (event: SyntheticEvent) => {
    if (!listRow) return;
    event.stopPropagation();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {listRow ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="More session actions"
              className="relative z-20 shrink-0"
              onPointerDown={stopPropagation}
              onClick={stopPropagation}
              disabled={isPending}
            >
              <MoreVertical />
            </Button>
          ) : (
            <SideNavItem
              side="right"
              label="More actions"
              tooltip="More actions"
            >
              <MoreVertical className="size-5" />
            </SideNavItem>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="left">
          <DropdownMenuItem
            onClick={() => stopTasks.mutate({ sessionId })}
            disabled={isPending}
            className="flex cursor-pointer items-center gap-2"
          >
            <Square className="size-4" />
            Stop all tasks
          </DropdownMenuItem>
          {sessionStatusExperimentEnabled ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-2">
                <Activity className="size-4" />
                Mark session as...
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={currentStatus}
                  onValueChange={(value) => {
                    if (value === currentStatus) return;
                    setStatus.mutate({
                      sessionId,
                      status: value as SessionManualStatus,
                    });
                  }}
                >
                  {SESSION_MANUAL_STATUSES.map((nextStatus) => (
                    <DropdownMenuRadioItem
                      key={nextStatus}
                      value={nextStatus}
                      disabled={isPending || nextStatus === currentStatus}
                      className="capitalize"
                    >
                      {getSessionStatusLabel(nextStatus)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuItem
            onClick={() => archiveSession.mutate({ sessionId })}
            disabled={isPending}
            className="flex cursor-pointer items-center gap-2"
          >
            <Archive className="size-4" />
            Archive session
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setOpen(true)}
            className="flex cursor-pointer items-center gap-2"
          >
            <Trash2 className="size-4" />
            Delete session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              {SESSION_DELETION_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteSession.mutate({ sessionId })}
              disabled={deleteSession.isPending}
            >
              {deleteSession.isPending ? 'Deleting...' : 'Delete session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

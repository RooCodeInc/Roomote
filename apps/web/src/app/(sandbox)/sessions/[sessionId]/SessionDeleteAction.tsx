'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
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
  DropdownMenuTrigger,
  MoreVertical,
  Trash2,
} from '@/components/system';

export const SESSION_DELETION_DESCRIPTION =
  'This first stops active tasks, then permanently deletes the session, its associated tasks and artifacts, and Brain memories saved directly from them. It does not remove independently collected Slack or pull request content, broader summaries, or every reference elsewhere. This action cannot be undone.';

export function SessionDeleteAction({ sessionId }: { sessionId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
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

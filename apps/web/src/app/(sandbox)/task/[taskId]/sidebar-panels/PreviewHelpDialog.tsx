'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Sparkles,
  Spinner,
} from '@/components/system';

/**
 * Help flow for a preview that exists but does not load or work correctly
 * (host checks, CORS, frame-blocking headers, and similar). Admins can launch
 * a repair agent for the task's environment; members are pointed to an admin.
 */
export function PreviewHelpDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuthorizedUser();
  const statusQuery = useQuery(
    trpc.previewSettings.taskStatus.queryOptions(
      { taskId: taskId ?? '' },
      { enabled: open && Boolean(taskId) },
    ),
  );
  const startRepairMutation = useMutation(
    trpc.previewSettings.startSetupTask.mutationOptions({
      onSuccess: (result) => {
        if (result.alreadyRunning) {
          toast.info('An agent is already working on this environment');
        } else {
          toast.success('Preview fix agent started');
        }

        queryClient.invalidateQueries({
          queryKey: trpc.previewSettings.taskStatus.queryKey({
            taskId: taskId ?? '',
          }),
        });
      },
      onError: () => {
        toast.error('Failed to start the preview fix agent');
      },
    }),
  );

  const setupTask = statusQuery.data?.setupTask ?? null;
  const environmentName = statusQuery.data?.environment?.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Preview not working?</DialogTitle>
          <DialogDescription>
            Fresh tasks can take a couple of minutes to start their app. If the
            preview stays blank or broken, the app may need changes to run
            behind the preview proxy, like allowing the preview host, framing,
            or cross-origin requests.
          </DialogDescription>
        </DialogHeader>

        {setupTask ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              An agent is already working on live previews
              {environmentName ? ` for ${environmentName}` : ''}.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/task/${setupTask.taskId}`}>
                View agent task
                <ArrowRight />
              </Link>
            </Button>
          </div>
        ) : isAdmin ? (
          <p className="text-sm text-muted-foreground">
            An agent can start this environment, reproduce the problem, and fix
            the environment or app configuration so the preview works.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an administrator to fix live previews for this environment.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {isAdmin && !setupTask ? (
            <Button
              onClick={() =>
                taskId && startRepairMutation.mutate({ taskId, mode: 'repair' })
              }
              disabled={!taskId || startRepairMutation.isPending}
            >
              {startRepairMutation.isPending ? <Spinner /> : <Sparkles />}
              Fix previews with an agent
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { TaskRun } from '@roomote/db';

import { SETTINGS_PATHS } from '@/lib/settings';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import type { TaskPreviewStatus } from '@/trpc/commands/preview-settings';
import {
  AppWindow,
  ArrowRight,
  Button,
  Skeleton,
  Sparkles,
  Spinner,
} from '@/components/system';
import { PreviewRuntimeSetup } from '@/components/previews/PreviewRuntimeSetup';

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex size-full items-center justify-center px-6 py-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {children}
      </div>
    </div>
  );
}

/**
 * Rendered in the preview pane when the task has no live preview URL. Explains
 * why, and offers the path to getting previews working: launching a setup
 * agent, configuring ports, or (for admins) configuring the preview runtime.
 */
export function PreviewSetupState({ taskRun }: { taskRun?: TaskRun }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuthorizedUser();
  const taskId = taskRun?.taskId;
  const statusQuery = useQuery(
    trpc.previewSettings.taskStatus.queryOptions(
      { taskId: taskId ?? '' },
      {
        enabled: Boolean(taskId),
        refetchInterval: (query) =>
          query.state.data?.setupTask ? 5_000 : 30_000,
      },
    ),
  );
  const startSetupMutation = useMutation(
    trpc.previewSettings.startSetupTask.mutationOptions({
      onSuccess: (result) => {
        if (result.alreadyRunning) {
          toast.info('An agent is already working on this environment');
        } else {
          toast.success('Preview setup agent started');
        }

        queryClient.invalidateQueries({
          queryKey: trpc.previewSettings.taskStatus.queryKey({
            taskId: taskId ?? '',
          }),
        });
      },
      onError: () => {
        toast.error('Failed to start the preview setup agent');
      },
    }),
  );

  if (!taskId || statusQuery.isError) {
    return (
      <CenteredMessage>
        <p className="text-sm text-muted-foreground">
          Live Preview is not available for this task.
        </p>
      </CenteredMessage>
    );
  }

  if (statusQuery.isPending) {
    return (
      <div className="flex size-full items-center justify-center px-6 py-8">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-9 w-48" />
        </div>
      </div>
    );
  }

  const status: TaskPreviewStatus = statusQuery.data;

  // Repo-only tasks have no environment to preview. The Live Preview button
  // is hidden for these tasks, so this state is only reachable via a direct
  // /previews URL.
  if (!status.environment) {
    return (
      <CenteredMessage>
        <AppWindow
          className="size-6 text-muted-foreground/50"
          strokeWidth={1}
        />
        <p className="text-sm font-medium">
          Live previews are available for tasks that run in an environment
        </p>
        <p className="text-sm text-muted-foreground">
          This task runs directly against the repository, so there is no running
          app to preview.
        </p>
      </CenteredMessage>
    );
  }

  // An agent is already working on this environment: either a preview
  // setup/repair agent or the environment's own setup/verification task.
  if (status.setupTask) {
    const isPreviewAgent = status.setupTask.kind === 'preview';

    return (
      <CenteredMessage>
        <Spinner className="size-5" />
        <p className="text-sm font-medium">
          {isPreviewAgent
            ? `An agent is setting up live previews for ${status.environment.name}`
            : `${status.environment.name} is still being set up`}
        </p>
        <p className="text-sm text-muted-foreground">
          {isPreviewAgent
            ? 'Once it finishes, new tasks in this environment will include a live preview.'
            : 'Live previews become available once the environment is ready.'}
        </p>
        {status.setupTask.taskId ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/task/${status.setupTask.taskId}`}>
              View setup task
              <ArrowRight />
            </Link>
          </Button>
        ) : null}
      </CenteredMessage>
    );
  }

  // Preview infrastructure is not configured for this deployment.
  if (!status.runtimeReady) {
    if (!isAdmin) {
      return (
        <CenteredMessage>
          <AppWindow
            className="size-6 text-muted-foreground/50"
            strokeWidth={1}
          />
          <p className="text-sm font-medium">
            Live previews aren&apos;t set up for this deployment yet
          </p>
          <p className="text-sm text-muted-foreground">
            Ask an administrator to configure live previews.
          </p>
        </CenteredMessage>
      );
    }

    return (
      <div className="size-full overflow-y-auto p-6">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Live previews need a one-time deployment setup before environments
            can publish preview URLs.
          </p>
          <PreviewRuntimeSetup />
        </div>
      </div>
    );
  }

  // Environment has no preview ports configured yet.
  if (!status.environment.hasConfiguredPorts) {
    return (
      <CenteredMessage>
        <AppWindow
          className="size-6 text-muted-foreground/50"
          strokeWidth={1}
        />
        <p className="text-sm font-medium">
          {status.environment.name} doesn&apos;t expose any preview ports yet
        </p>
        {isAdmin ? (
          <>
            <p className="text-sm text-muted-foreground">
              An agent can find the web app in this environment, verify that it
              runs, and publish a live preview for future tasks.
            </p>
            <Button
              size="sm"
              onClick={() => startSetupMutation.mutate({ taskId })}
              disabled={startSetupMutation.isPending}
            >
              {startSetupMutation.isPending ? <Spinner /> : <Sparkles />}
              Set up previews with an agent
            </Button>
            <p className="text-sm text-muted-foreground">
              Or{' '}
              <Link
                href={SETTINGS_PATHS.editEnvironment(status.environment.id)}
                className="text-primary underline hover:no-underline"
              >
                configure ports manually
              </Link>
              .
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an administrator to set up live previews for this environment.
          </p>
        )}
      </CenteredMessage>
    );
  }

  // Ports are configured, but this run started before they existed.
  return (
    <CenteredMessage>
      <AppWindow className="size-6 text-muted-foreground/50" strokeWidth={1} />
      <p className="text-sm font-medium">
        This task started before live previews were configured for{' '}
        {status.environment.name}
      </p>
      <p className="text-sm text-muted-foreground">
        New tasks will include a live preview of{' '}
        <span className="font-mono">
          {status.environment.portNames.join(', ')}
        </span>
        . To attach a preview to this task, put it to sleep and wake it again.
      </p>
    </CenteredMessage>
  );
}

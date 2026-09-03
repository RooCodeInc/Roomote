'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowLeftFromLine,
  BasicTooltip,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/system';
import { PullRequestBadge, WorkspaceBadge } from '@/components/sandbox';
import { WorkspaceHeader } from '@/components/layout';

import { useTRPC } from '@/trpc/client';
import { useSandboxLayout } from '../../use-sandbox-layout';

import { type TaskSession } from './hooks';
import { TaskSessionReadTracker } from './TaskSessionReadTracker';

interface HeaderProps {
  session: TaskSession;
}

export const Header = ({ session: { taskRun, task, taskId } }: HeaderProps) => {
  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task?.title ?? '');
  const { data: parentSession } = useQuery(
    trpc.sessions.forTask.queryOptions({ taskId }),
  );

  const environmentId = taskRun?.payload?.environmentId;
  const repo = taskRun?.payload?.repo;
  const prRepo = taskRun?.prRepo;
  const prNumber = taskRun?.prNumber;
  const pullRequests = taskRun?.pullRequests ?? [];
  const sessionHref = parentSession
    ? `/sessions/${parentSession.sessionId}?task=${taskId}`
    : taskRun?.payload?.fastAgentSessionId
      ? `/sessions/${taskRun.payload.fastAgentSessionId}`
      : null;

  const badges = [
    (environmentId || repo) && (
      <WorkspaceBadge
        key="workspace"
        environmentId={environmentId}
        repo={repo}
        iconClassName="text-muted-foreground"
      />
    ),
    ...(pullRequests.length > 0
      ? pullRequests.map((pullRequest) => (
          <PullRequestBadge
            key={`pr:${pullRequest.repository}:${pullRequest.prNumber}`}
            repo={pullRequest.repository}
            prNumber={pullRequest.prNumber}
            url={pullRequest.prUrl}
            iconClassName="text-muted-foreground"
          />
        ))
      : prRepo && prNumber
        ? [
            <PullRequestBadge
              key="pr"
              repo={prRepo}
              prNumber={prNumber}
              iconClassName="text-muted-foreground"
            />,
          ]
        : []),
  ].filter(Boolean);

  const updateTaskTitle = useMutation(trpc.tasks.updateTitle.mutationOptions());

  useEffect(() => {
    if (!isRenameDialogOpen) {
      setTitleDraft(task?.title ?? '');
    }
  }, [isRenameDialogOpen, task?.title]);

  const sandboxSessionQueryKey = trpc.sandboxSession.byTaskId.queryKey({
    taskId,
  });

  const setTaskTitleInCache = (title: string) => {
    queryClient.setQueryData(sandboxSessionQueryKey, (current) => {
      if (!current?.task) {
        return current;
      }

      return {
        ...current,
        task: {
          ...current.task,
          title,
        },
      };
    });
  };

  const handleOpenRenameDialog = () => {
    setTitleDraft(task?.title ?? '');
    setIsRenameDialogOpen(true);
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLHeadingElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpenRenameDialog();
    }
  };

  const handleSaveTitle = async () => {
    const nextTitle = titleDraft.trim();
    const currentTitle = (task?.title ?? '').trim();

    if (!nextTitle) {
      return;
    }

    setIsRenameDialogOpen(false);

    if (nextTitle === currentTitle) {
      return;
    }

    const previousTitle = task?.title ?? '';
    setTaskTitleInCache(nextTitle);

    try {
      await updateTaskTitle.mutateAsync({
        taskId,
        title: nextTitle,
      });
    } catch (error) {
      setTaskTitleInCache(previousTitle);
      toast.error(
        error instanceof Error ? error.message : 'Failed to rename task.',
      );
    } finally {
      void queryClient.invalidateQueries({
        queryKey: sandboxSessionQueryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.tasks.list.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.tasks.search.queryKey(),
      });
    }
  };

  const title = task?.title || 'Untitled task';
  return (
    <>
      {parentSession ? (
        <TaskSessionReadTracker sessionId={parentSession.sessionId} />
      ) : null}
      <WorkspaceHeader contentClassName="flex-row items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {sessionHref ? (
            <BasicTooltip content="Back to session">
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
              >
                <Link href={sessionHref} aria-label="Back to session">
                  <ArrowLeft className="size-3.5" />
                </Link>
              </Button>
            </BasicTooltip>
          ) : null}
          <h1
            role="button"
            tabIndex={0}
            onClick={handleOpenRenameDialog}
            onKeyDown={handleTitleKeyDown}
            aria-label="Edit task title"
            title="Edit task title"
            className={`min-w-0 max-w-full cursor-pointer overflow-hidden rounded-md border border-transparent px-2 py-1 text-sm font-medium text-ellipsis whitespace-nowrap hover:border-border hover:bg-muted/40 focus-visible:border-border focus-visible:bg-muted/40 focus-visible:outline-none @[600px]:flex-[0_1_auto] ${sessionHref ? '-ml-2' : '-ml-3'} ${!isSidebarVisible ? 'pr-8' : ''}`}
          >
            {title}
          </h1>
        </div>
        {badges.length > 0 && (
          <div className="flex min-w-0 shrink-0 items-center gap-4 overflow-hidden text-xs text-muted-foreground">
            {badges.map((badge, index) => (
              <span key={index} className="contents">
                {badge}
              </span>
            ))}
          </div>
        )}
        {!isSidebarVisible && (
          <Button
            variant="ghost"
            onClick={toggleSidebar}
            className="absolute -top-0.5 right-3 size-8 shrink-0"
          >
            <ArrowLeftFromLine className="size-4" />
          </Button>
        )}
      </WorkspaceHeader>
      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Edit task title</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveTitle();
            }}
          >
            <Input
              type="text"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              maxLength={500}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsRenameDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!titleDraft.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

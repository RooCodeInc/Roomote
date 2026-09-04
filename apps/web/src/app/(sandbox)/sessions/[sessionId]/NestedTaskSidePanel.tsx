'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';

import { DEFAULT_CODING_HARNESS, type TaskPhase } from '@roomote/types';

import {
  BasicTooltip,
  Button,
  ChevronDown,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  ErrorState,
  ExternalLink,
  Skeleton,
} from '@/components/system';
import { WorkspaceBadge } from '@/components/sandbox';
import { FramedSurface } from '@/components/layout';
import { TaskRobotIcon } from '@/components/tasks/TaskRobotIcon';

import { ArtifactLinkProvider } from '../../task/[taskId]/hooks/ArtifactLinkProvider';
import { HistoricalSandboxProvider } from '../../task/[taskId]/hooks/HistoricalSandboxProvider';
import { SandboxProvider } from '../../task/[taskId]/hooks/SandboxProvider';
import { useSleepInvalidation } from '../../task/[taskId]/hooks/use-sleep-invalidation';
import { useTaskMessageEnvelopes } from '../../task/[taskId]/hooks/use-task-message-envelopes';
import {
  useTaskSession,
  type TaskSession,
} from '../../task/[taskId]/hooks/use-task-session';
import { CommandSearch } from '../../task/[taskId]/CommandSearch';
import { ConnectionStatusBanner } from '../../task/[taskId]/ErrorFallback';
import { FileSearch } from '../../task/[taskId]/FileSearch';
import { Messages, type MessagesHandle } from '../../task/[taskId]/Messages';
import { PendingUserInputRequestStateProvider } from '../../task/[taskId]/PendingUserInputRequestPanel';
import type { PromptInputHandle } from '../../task/[taskId]/prompt-input';
import { isTaskRunAsleep } from '../../task/[taskId]/sidebar-actions/utils';
import { SidePanelHeader } from '../../task/[taskId]/sidebar-panels/SidePanelHeader';
import { Startup } from '../../task/[taskId]/startup';
import { TaskInputStack } from '../../task/[taskId]/TaskInputStack';
import { DraftPromptBanner } from '../../task/[taskId]/DraftPromptBanner';
import { WakeTaskInput } from '../../task/[taskId]/WakeTaskInput';

function NestedTaskInputTray({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card outline-0 outline-offset-[-2px] outline-accent-foreground transition-[background-color,border-color,outline-width] has-[textarea:focus]:outline-2 @[56rem]:rounded-t-lg">
      {children}
    </div>
  );
}

function NestedTaskInteraction({
  session,
  footer,
}: {
  session: TaskSession;
  footer?: ReactNode;
}) {
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const promptInputRef = useRef<PromptInputHandle | null>(null);
  const messagesRef = useRef<MessagesHandle | null>(null);
  const fileInsertPositionRef = useRef<number | null>(null);
  const commandInsertPositionRef = useRef<number | null>(null);

  const handleFileSearchOpen = useCallback((insertPosition?: number) => {
    fileInsertPositionRef.current = insertPosition ?? null;
    setFileSearchOpen(true);
  }, []);
  const handleCommandSearchOpen = useCallback((insertPosition?: number) => {
    commandInsertPositionRef.current = insertPosition ?? null;
    setCommandSearchOpen(true);
  }, []);
  const handleSelectFile = useCallback((path: string) => {
    promptInputRef.current?.insertFile(path, fileInsertPositionRef.current);
    fileInsertPositionRef.current = null;
  }, []);
  const handleSelectCommand = useCallback((name: string) => {
    promptInputRef.current?.insertCommand(
      name,
      commandInsertPositionRef.current,
    );
    commandInsertPositionRef.current = null;
  }, []);
  const scrollToBottom = useCallback(() => {
    void messagesRef.current?.scrollToBottom();
  }, []);

  useSleepInvalidation(session.taskRun);

  return (
    <>
      <ConnectionStatusBanner session={session} />
      <Messages
        session={session}
        scrollRef={messagesRef}
        initialScrollBehavior="instant"
        conversationClassName="mx-auto w-full max-w-4xl p-4 pt-0"
        messageUiOptions={{ displayMode: 'default' }}
        footer={footer}
      />
      <NestedTaskInputTray>
        <PendingUserInputRequestStateProvider taskId={session.taskId}>
          <TaskInputStack
            session={session}
            promptInputRef={promptInputRef}
            onFileSearchOpen={handleFileSearchOpen}
            onCommandSearchOpen={handleCommandSearchOpen}
            scrollToBottom={scrollToBottom}
            promptPlaceholder="Message task, / for commands"
          />
        </PendingUserInputRequestStateProvider>
      </NestedTaskInputTray>
      <FileSearch
        open={fileSearchOpen}
        onOpenChange={setFileSearchOpen}
        onSelectFile={handleSelectFile}
      />
      <CommandSearch
        open={commandSearchOpen}
        onOpenChange={setCommandSearchOpen}
        onSelectCommand={handleSelectCommand}
      />
    </>
  );
}

function HistoricalNestedTaskInteraction({
  session,
  footer,
}: {
  session: TaskSession;
  footer?: ReactNode;
}) {
  const taskRun = session.taskRun;
  const isAsleep = isTaskRunAsleep(taskRun);
  const shouldShowWakeTaskInput = isAsleep && Boolean(taskRun?.snapshotId);

  return (
    <>
      <Messages
        session={session}
        initialScrollBehavior="instant"
        conversationClassName="mx-auto w-full max-w-4xl p-4 pt-0"
        messageUiOptions={{ displayMode: 'default' }}
        footer={footer}
      />
      {shouldShowWakeTaskInput && taskRun ? (
        <NestedTaskInputTray>
          <WakeTaskInput
            taskRun={taskRun}
            initialPrompt={session.draftPrompt ?? ''}
            embedded
          />
        </NestedTaskInputTray>
      ) : session.sessionState === 'resuming' && session.draftPrompt ? (
        <NestedTaskInputTray>
          <DraftPromptBanner draftPrompt={session.draftPrompt} embedded />
        </NestedTaskInputTray>
      ) : null}
    </>
  );
}

function NestedTaskTranscript({
  session,
  onOpenArtifact,
}: {
  session: TaskSession;
  onOpenArtifact?: (path: string, version?: number) => void;
}) {
  const history = useTaskMessageEnvelopes(session.taskId);

  if (session.isSessionLoading) {
    return (
      <div aria-label="Loading task" className="space-y-4 p-4">
        <Skeleton className="h-16 w-3/4 rounded-2xl" />
        <Skeleton className="ml-auto h-20 w-4/5 rounded-2xl" />
        <Skeleton className="h-12 w-2/3 rounded-2xl" />
      </div>
    );
  }

  if (
    session.sessionState === 'error' ||
    session.sessionState === 'not-found'
  ) {
    return <ErrorState title="Task unavailable" />;
  }

  if (!session.taskRun) {
    return <ErrorState title="Task is still preparing" />;
  }

  if (session.sessionState === 'boot-failed') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
          <Startup
            runId={session.taskRun.id}
            initialTaskRun={session.taskRun}
          />
        </div>
      </div>
    );
  }

  const hasTranscriptHistory = (history.data?.length ?? 0) > 0;
  const hasVisibleSessionPrompt =
    session.prompt?.visibleInTranscript !== false && session.prompt != null;
  const bootingTaskRun =
    session.sessionState === 'booting' ? session.taskRun : null;

  if (bootingTaskRun && !hasTranscriptHistory && !hasVisibleSessionPrompt) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
          <Startup runId={bootingTaskRun.id} initialTaskRun={bootingTaskRun} />
        </div>
      </div>
    );
  }

  const footer = bootingTaskRun ? (
    <Startup runId={bootingTaskRun.id} initialTaskRun={bootingTaskRun} />
  ) : null;
  const historicalTranscript = (
    <ArtifactLinkProvider session={session} onOpenArtifact={onOpenArtifact}>
      <HistoricalNestedTaskInteraction session={session} footer={footer} />
    </ArtifactLinkProvider>
  );

  if (
    session.sessionState === 'historical' ||
    session.sessionState === 'resuming'
  ) {
    return (
      <HistoricalSandboxProvider
        key={session.taskId}
        taskId={session.taskId}
        history={history}
        harness={session.taskRun.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={session.taskRun.status}
        taskPhase={session.taskRun.taskPhase as TaskPhase | null | undefined}
      >
        {historicalTranscript}
      </HistoricalSandboxProvider>
    );
  }

  return (
    <SandboxProvider
      key={session.taskId}
      taskId={session.taskId}
      url={session.taskRun.sandboxServerUrl}
      token={session.token}
      refreshConnection={session.refreshConnection}
      history={history}
      initialTaskStatus={session.taskRun.status}
      initialTaskPhase={
        session.taskRun.taskPhase as TaskPhase | null | undefined
      }
    >
      <ArtifactLinkProvider session={session} onOpenArtifact={onOpenArtifact}>
        <NestedTaskInteraction session={session} footer={footer} />
      </ArtifactLinkProvider>
    </SandboxProvider>
  );
}

export function NestedTaskSidePanel({
  taskId,
  tasks = [],
  onSelectTask,
  onClose,
  onOpenArtifact,
}: {
  taskId: string;
  tasks?: Array<{ taskId: string; title: string }>;
  onSelectTask?: (taskId: string) => void;
  onClose: () => void;
  onOpenArtifact?: (path: string, version?: number) => void;
}) {
  const session = useTaskSession(taskId, { refetchInterval: 2_000 });
  const title = session.task?.title?.trim() || 'Task';
  const environmentId = session.taskRun?.payload?.environmentId;
  const repo = session.taskRun?.payload?.repo;

  return (
    <FramedSurface
      data-session-task-panel={taskId}
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SidePanelHeader
        onClose={onClose}
        actions={
          <>
            {environmentId || repo ? (
              <WorkspaceBadge
                environmentId={environmentId}
                repo={repo}
                className="max-w-32 text-xs text-muted-foreground"
                iconClassName="text-muted-foreground"
              />
            ) : null}
            <BasicTooltip content="Go to task">
              <Button asChild variant="ghost" size="icon" className="size-8">
                <Link href={`/task/${taskId}`} aria-label="Go to task">
                  <ExternalLink className="size-4" />
                </Link>
              </Button>
            </BasicTooltip>
          </>
        }
        titleAdornment={
          tasks.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="relative -left-2 flex h-7 w-full min-w-0 justify-start gap-1.5 px-2 text-sm hover:text-accent-foreground"
                >
                  <TaskRobotIcon taskId={taskId} className="size-6" />
                  <span className="shrink-0 font-semibold">Task:</span>
                  <span className="min-w-0 flex-1 truncate text-left font-medium">
                    {title}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80">
                <DropdownMenuLabel>Tasks in this session</DropdownMenuLabel>
                {tasks.map((task) => (
                  <DropdownMenuItem
                    key={task.taskId}
                    className="cursor-pointer text-xs"
                    onClick={() => onSelectTask?.(task.taskId)}
                  >
                    <span className="max-w-72 truncate">{task.title}</span>
                    {task.taskId === taskId ? (
                      <span className="ml-auto text-muted-foreground">
                        &bull;
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h2 className="truncate text-sm font-medium whitespace-nowrap">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <TaskRobotIcon taskId={taskId} className="size-6" />
                <span className="font-semibold">Task:</span>
                <span className="truncate">{title}</span>
              </span>
            </h2>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <NestedTaskTranscript
          session={session}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    </FramedSurface>
  );
}

'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { TaskPhase } from '@roomote/types';

import { WorkspaceSurface, useRegisterCommands } from '@/components/layout';
import { FileDiffIcon, Info, Logs, Terminal } from '@/components/system';

import {
  type TaskSession,
  ArtifactLinkProvider,
  PreviewPaneProvider,
  useLogFiles,
  useSandboxTaskPhase,
  useDiffView,
  useSleepInvalidation,
  useTaskSidePanel,
  TaskSidePanelProvider,
} from './hooks';

import { SidebarActions, isTaskRunAsleep } from './sidebar-actions';
import type { PromptInputHandle } from './prompt-input';

import { Header } from './Header';
import { Messages, type MessagesHandle } from './Messages';
import { FileSearch } from './FileSearch';
import { CommandSearch } from './CommandSearch';
import { PreviewCommand } from './PreviewCommand';
import { PreviewPaneLayout } from './PreviewPaneLayout';
import { ConnectionStatusBanner } from './ErrorFallback';
import { PendingUserInputRequestStateProvider } from './PendingUserInputRequestPanel';
import { TaskInputStack } from './TaskInputStack';
import { OnboardingCompletionMessage } from './OnboardingCompletionMessage';
import { ProductTips, Startup } from './startup';

interface LiveContentProps {
  session: TaskSession;
  newTaskHref: string;
  onBootStatusChange?: () => void;
  onTaskPhaseChange?: (phase: TaskPhase | null) => void;
}

function LiveContent({
  session,
  newTaskHref,
  onBootStatusChange,
  onTaskPhaseChange,
}: LiveContentProps) {
  return (
    <TaskSidePanelProvider
      taskId={session.taskId}
      artifacts={session.artifacts}
    >
      <LiveContentInner
        session={session}
        newTaskHref={newTaskHref}
        onBootStatusChange={onBootStatusChange}
        onTaskPhaseChange={onTaskPhaseChange}
      />
    </TaskSidePanelProvider>
  );
}

function LiveContentInner({
  session,
  newTaskHref,
  onBootStatusChange,
  onTaskPhaseChange,
}: LiveContentProps) {
  const { payload } = session.taskRun ?? {};

  const taskPhase = useSandboxTaskPhase();
  const diffView = useDiffView(Boolean(session.taskRun));
  const {
    openTaskInfoView,
    openDiffView,
    openLogsView,
    openTerminalView,
    closeSidePanel,
    isViewActive,
  } = useTaskSidePanel();

  // Derive logfiles from the environment config and sync them into the task
  // sandbox store so sidebar panels and actions can read them consistently.
  const logfiles = useLogFiles(payload?.environmentId);

  useEffect(() => {
    onTaskPhaseChange?.(taskPhase ?? null);

    return () => {
      onTaskPhaseChange?.(null);
    };
  }, [onTaskPhaseChange, taskPhase]);

  const asleep = isTaskRunAsleep(session.taskRun);
  const bootingTaskRun =
    session.sessionState === 'booting' ? session.taskRun : null;

  const [messagesInitialScrollBehavior, setMessagesInitialScrollBehavior] =
    useState<'smooth' | 'instant'>('smooth');

  useEffect(() => {
    setMessagesInitialScrollBehavior('instant');
  }, []);

  const [fileSearchOpen, setFileSearchOpenRaw] = useState(false);
  const [commandSearchOpen, setCommandSearchOpenRaw] = useState(false);

  const promptInputRef = useRef<PromptInputHandle | null>(null);

  const messagesRef = useRef<MessagesHandle | null>(null);
  const fileInsertPositionRef = useRef<number | null>(null);

  // Tracks the cursor position right after the "/" that triggered command
  // search, so the selected command can be inserted at that position.
  const commandInsertPositionRef = useRef<number | null>(null);
  const setFileSearchOpen = useCallback(
    (open: boolean | ((prev: boolean) => boolean)) => {
      setFileSearchOpenRaw((prev) => {
        const next = typeof open === 'function' ? open(prev) : open;

        if (!next) {
          requestAnimationFrame(() => promptInputRef.current?.focus());
        }

        return next;
      });
    },
    [],
  );

  const setCommandSearchOpen = useCallback(
    (open: boolean | ((prev: boolean) => boolean)) => {
      setCommandSearchOpenRaw((prev) => {
        const next = typeof open === 'function' ? open(prev) : open;

        if (!next) {
          requestAnimationFrame(() => promptInputRef.current?.focus());
        }

        return next;
      });
    },
    [],
  );

  const handleSelectFile = useCallback((path: string) => {
    const insertPos = fileInsertPositionRef.current;
    fileInsertPositionRef.current = null;

    promptInputRef.current?.insertFile(path, insertPos);
  }, []);

  const handleFileSearchOpen = useCallback(
    (insertPosition?: number) => {
      fileInsertPositionRef.current = insertPosition ?? null;
      setFileSearchOpen(true);
    },
    [setFileSearchOpen],
  );

  const handleCommandSearchOpen = useCallback(
    (insertPosition?: number) => {
      commandInsertPositionRef.current = insertPosition ?? null;
      setCommandSearchOpen(true);
    },
    [setCommandSearchOpen],
  );

  const handleSelectCommand = useCallback((name: string) => {
    const insertPos = commandInsertPositionRef.current;
    commandInsertPositionRef.current = null;

    promptInputRef.current?.insertCommand(name, insertPos);
  }, []);

  const scrollToBottom = useCallback(() => {
    void messagesRef.current?.scrollToBottom();
  }, []);

  useRegisterCommands([
    ...(session.task && session.taskRun
      ? [
          {
            id: 'task-info',
            icon: Info,
            label: 'Info',
            group: 'Task actions',
            action: () => openTaskInfoView(),
            keywords: ['info', 'details', 'task info'],
          },
        ]
      : []),
    ...(session.taskRun
      ? [
          {
            id: 'task-terminal',
            icon: Terminal,
            label: 'Terminal',
            group: 'Task actions',
            action: () => openTerminalView(),
            keywords: ['terminal', 'shell', 'console'],
          },
          ...(logfiles.length > 0
            ? [
                {
                  id: 'task-logs',
                  icon: Logs,
                  label: 'Logs',
                  group: 'Task actions',
                  action: () => openLogsView(),
                  keywords: ['logs', 'log file', 'output'],
                },
              ]
            : []),
          {
            id: 'task-diff',
            icon: FileDiffIcon,
            label: 'Diff',
            group: 'Task actions',
            action: () => openDiffView(),
            keywords: ['diff', 'changes', 'git'],
          },
        ]
      : []),
  ]);

  return (
    <PreviewPaneProvider>
      <WorkspaceSurface
        sideActions={
          <SidebarActions
            session={session}
            showDiff={isViewActive('diff')}
            onToggleDiff={() =>
              isViewActive('diff') ? closeSidePanel() : openDiffView()
            }
            changedFileCount={diffView.data?.summary.changedFileCount ?? 0}
            isDiffLoading={diffView.isLoading}
          />
        }
      >
        <PreviewPaneLayout
          session={session}
          diffPanel={{
            data: diffView.data,
            error: diffView.error,
            isLoading: diffView.isLoading,
            onRefresh: diffView.refresh,
          }}
        >
          <ArtifactLinkProvider session={session}>
            <PreviewCommand taskRun={session.taskRun ?? null} asleep={asleep} />
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
              <Header session={session} />
              <ConnectionStatusBanner session={session} />
              <Messages
                session={session}
                scrollRef={messagesRef}
                initialScrollBehavior={messagesInitialScrollBehavior}
                footer={
                  <>
                    {session.onboardingEnvironment && (
                      <OnboardingCompletionMessage
                        environment={session.onboardingEnvironment}
                      />
                    )}
                    {bootingTaskRun && (
                      <>
                        <Startup
                          runId={bootingTaskRun.id}
                          initialTaskRun={bootingTaskRun}
                          newTaskHref={newTaskHref}
                          onStatusChange={onBootStatusChange}
                        />
                        <ProductTips />
                      </>
                    )}
                  </>
                }
              />
              <div className="mx-auto w-full overflow-clip rounded-t-md bg-card @[56rem]:rounded-t-lg transition-colors border-2 border-background rounded-b-3xl">
                <PendingUserInputRequestStateProvider taskId={session.taskId}>
                  <TaskInputStack
                    session={session}
                    promptInputRef={promptInputRef}
                    onFileSearchOpen={handleFileSearchOpen}
                    onCommandSearchOpen={handleCommandSearchOpen}
                    scrollToBottom={scrollToBottom}
                  />
                </PendingUserInputRequestStateProvider>
              </div>
            </div>
          </ArtifactLinkProvider>
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
          <SleepInvalidationEffect taskRun={session.taskRun} />
        </PreviewPaneLayout>
      </WorkspaceSurface>
    </PreviewPaneProvider>
  );
}

function SleepInvalidationEffect({
  taskRun,
}: {
  taskRun: TaskSession['taskRun'];
}) {
  useSleepInvalidation(taskRun);
  return null;
}

function areLiveContentPropsEqual(
  prev: LiveContentProps,
  next: LiveContentProps,
): boolean {
  return (
    prev.session === next.session &&
    prev.onTaskPhaseChange === next.onTaskPhaseChange
  );
}

export const MemoizedLiveContent = memo(LiveContent, areLiveContentPropsEqual);

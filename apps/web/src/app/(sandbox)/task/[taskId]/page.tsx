'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CircleSlash, TriangleAlert } from '@/components/system';

import {
  TaskPayloadKind,
  DEFAULT_CODING_HARNESS,
  isExitedRunStatus,
  type TaskPhase,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useRecentTasks } from '@/hooks/useRecentTasks';

import { FramedSurface, Loading } from '@/components/layout';
import { EmptyState } from '@/components/system';

import { useSandboxLayout } from '../../use-sandbox-layout';

import {
  HistoricalSandboxProvider,
  SandboxProvider,
  useTaskSession,
  useTaskCompletionNotification,
  useTaskMessageEnvelopes,
} from './hooks';

import { SnapshotResumeFailureFooter, Startup } from './startup';
import { DraftPromptBanner } from './DraftPromptBanner';
import { Header } from './Header';
import { HistoricalContent } from './HistoricalContent';
import { getTaskNotificationPhase } from './hooks/task-notification-phase';
import { MemoizedLiveContent } from './LiveContent';

export default function SandboxPage() {
  const { taskId: unresolvedTaskId } = useParams<{ taskId: string }>();
  const { setSidebarVisible } = useSandboxLayout();

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const session = useTaskSession(unresolvedTaskId, {
    refetchInterval: 30_000,
  });

  const historyEnvelopesQuery = useTaskMessageEnvelopes(unresolvedTaskId, {
    enabled: true,
  });

  const [liveTaskPhase, setLiveTaskPhase] = useState<TaskPhase | null>(null);

  const { taskRun, task, token, taskId, sessionState, isSessionLoading } =
    session;
  const lastHistoryRefreshSignalRef = useRef<string | null>(null);
  const activeRunId = taskRun?.id;
  const activeTaskRunStatus = taskRun?.status;
  const activeTaskRunTaskPhase = taskRun?.taskPhase;
  const hasTranscriptHistory = (historyEnvelopesQuery.data?.length ?? 0) > 0;
  const hasArtifacts = session.artifacts.length > 0;
  const hasVisibleSessionPrompt =
    session.prompt?.visibleInTranscript !== false && session.prompt != null;
  const startupPrompt = hasVisibleSessionPrompt
    ? {
        text: session.prompt?.text,
        images: session.prompt?.images,
      }
    : null;
  const shouldRenderBootingTranscript =
    sessionState === 'booting' &&
    (hasTranscriptHistory || hasVisibleSessionPrompt);
  const shouldRenderHistoricalBootFailure =
    taskRun?.payloadKind === TaskPayloadKind.SnapshotResume &&
    sessionState === 'boot-failed' &&
    (hasTranscriptHistory || hasArtifacts || hasVisibleSessionPrompt);
  const handleBootStatusChange = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: trpc.sandboxSession.byTaskId.queryKey(),
    });
  }, [queryClient, trpc]);

  useLayoutEffect(() => {
    const mobileQuery = window.matchMedia?.('(max-width: 767px)');

    if (!mobileQuery?.matches) {
      return;
    }

    setSidebarVisible(false);

    const handleViewportChange = (event: MediaQueryListEvent) =>
      setSidebarVisible(!event.matches);

    mobileQuery.addEventListener('change', handleViewportChange);

    return () => {
      mobileQuery.removeEventListener('change', handleViewportChange);
      setSidebarVisible(true);
    };
  }, [setSidebarVisible, unresolvedTaskId]);

  // Track this task as recently visited for command palette ordering.
  // Record immediately with the URL param so visits are captured even when the
  // session fails to initialise. If the resolved taskId differs (e.g. alias
  // resolution), record that too so the canonical id is promoted.
  const { recordVisit } = useRecentTasks();

  useEffect(
    () => recordVisit(unresolvedTaskId),
    [unresolvedTaskId, recordVisit],
  );

  useEffect(() => {
    if (taskId && taskId !== unresolvedTaskId) {
      recordVisit(taskId);
    }
  }, [taskId, unresolvedTaskId, recordVisit]);

  usePageTitle(
    task && task.title.length > 60
      ? `${task.title.slice(0, 60)}...`
      : task?.title,
  );

  useEffect(() => {
    if (sessionState !== 'interactive') {
      setLiveTaskPhase(null);
    }
  }, [sessionState]);

  useEffect(() => {
    if (
      !taskId ||
      !activeRunId ||
      !activeTaskRunStatus ||
      sessionState !== 'interactive' ||
      isExitedRunStatus(activeTaskRunStatus)
    ) {
      return;
    }

    const historyRefreshSignal = [
      activeRunId,
      activeTaskRunStatus,
      activeTaskRunTaskPhase ?? '',
    ].join(':');

    if (historyRefreshSignal === lastHistoryRefreshSignalRef.current) {
      return;
    }

    lastHistoryRefreshSignalRef.current = historyRefreshSignal;

    void queryClient.invalidateQueries({
      queryKey: trpc.tasks.messageEnvelopes.queryKey({ taskId }),
    });
  }, [
    activeRunId,
    activeTaskRunStatus,
    activeTaskRunTaskPhase,
    queryClient,
    sessionState,
    taskId,
    trpc.tasks.messageEnvelopes,
  ]);

  const taskPhase = getTaskNotificationPhase({
    sessionState,
    liveTaskPhase,
    persistedTaskPhase: taskRun?.taskPhase as TaskPhase | null | undefined,
  });

  // Notify with a beep + green-dot favicon when the task finishes work, needs
  // input, or wakes from sleep and becomes ready again while the tab is hidden.
  useTaskCompletionNotification(taskPhase ?? undefined, { sessionState });

  if (isSessionLoading) {
    return (
      <FramedSurface surfaceClassName="flex items-center justify-center">
        <Loading layout="centered" className="flex-1" />
      </FramedSurface>
    );
  }

  if (sessionState === 'error') {
    return (
      <FramedSurface surfaceClassName="flex items-center justify-center">
        <EmptyState
          icon={<TriangleAlert className="size-6" />}
          iconClassName="text-amber-500 pt-0"
          containerClassName="[&>div]:items-center"
          description="This task could not be loaded. Refresh the page or try again in a moment."
        />
      </FramedSurface>
    );
  }

  if (sessionState === 'not-found') {
    return (
      <FramedSurface surfaceClassName="flex items-center justify-center">
        <EmptyState
          icon={<CircleSlash className="size-6" />}
          iconClassName="text-rose-500 pt-0"
          containerClassName="[&>div]:items-center"
          description="This task does not exist or you do not have permission to view it."
        />
      </FramedSurface>
    );
  }

  if (!taskRun) {
    return (
      <FramedSurface surfaceClassName="flex items-center justify-center">
        <EmptyState
          icon={<TriangleAlert className="size-6" />}
          iconClassName="text-amber-500 pt-0"
          containerClassName="[&>div]:items-center"
          description="This task session is still preparing. Refresh the page or try again in a moment."
        />
      </FramedSurface>
    );
  }

  if (sessionState === 'historical' || sessionState === 'resuming') {
    return (
      <HistoricalSandboxProvider
        taskId={taskId}
        history={historyEnvelopesQuery}
        harness={taskRun?.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={taskRun?.status ?? null}
        taskPhase={(taskRun?.taskPhase as TaskPhase | null | undefined) ?? null}
        fallback={
          <>
            <Header session={session} />
            <Loading layout="centered" className="flex-1" />
          </>
        }
      >
        <HistoricalContent session={session} />
      </HistoricalSandboxProvider>
    );
  }

  if (shouldRenderHistoricalBootFailure) {
    return (
      <HistoricalSandboxProvider
        taskId={taskId}
        history={historyEnvelopesQuery}
        harness={taskRun?.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={taskRun?.status ?? null}
        taskPhase={(taskRun?.taskPhase as TaskPhase | null | undefined) ?? null}
        fallback={
          <>
            <Header session={session} />
            <Loading layout="centered" className="flex-1" />
          </>
        }
      >
        <HistoricalContent
          session={session}
          footer={
            taskRun ? (
              <SnapshotResumeFailureFooter
                taskId={taskId}
                taskRun={taskRun}
                prompt={startupPrompt}
              />
            ) : null
          }
        />
      </HistoricalSandboxProvider>
    );
  }

  if (sessionState === 'boot-failed') {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Header session={session} />
        <Startup
          runId={taskRun.id}
          taskId={taskId}
          initialTaskRun={taskRun}
          prompt={startupPrompt}
          onStatusChange={handleBootStatusChange}
        />
        {session.draftPrompt && (
          <DraftPromptBanner draftPrompt={session.draftPrompt} />
        )}
      </div>
    );
  }

  if (sessionState === 'booting' && !shouldRenderBootingTranscript) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Header session={session} />
        <Startup
          runId={taskRun.id}
          taskId={taskId}
          initialTaskRun={taskRun}
          prompt={startupPrompt}
          onStatusChange={handleBootStatusChange}
        />
        {session.draftPrompt && (
          <DraftPromptBanner draftPrompt={session.draftPrompt} />
        )}
      </div>
    );
  }

  return (
    <SandboxProvider
      taskId={taskId}
      url={taskRun.sandboxServerUrl}
      token={token}
      refreshConnection={session.refreshConnection}
      history={historyEnvelopesQuery}
      initialTaskStatus={taskRun?.status ?? null}
      initialTaskPhase={
        (taskRun?.taskPhase as TaskPhase | null | undefined) ?? null
      }
      fallback={
        <>
          <Header session={session} />
          <Loading layout="centered" className="flex-1" />
        </>
      }
    >
      <MemoizedLiveContent
        session={session}
        onBootStatusChange={handleBootStatusChange}
        onTaskPhaseChange={setLiveTaskPhase}
      />
    </SandboxProvider>
  );
}

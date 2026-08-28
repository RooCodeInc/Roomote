'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CircleSlash, TriangleAlert } from '@/components/system';

import {
  TaskPayloadKind,
  DEFAULT_CODING_HARNESS,
  getLinkedEnvironmentIdFromPayload,
  type TaskPhase,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useRecentTasks } from '@/hooks/useRecentTasks';
import { truncatePageTitle } from '@/lib/page-title';

import { FramedSurface } from '@/components/layout';
import { EmptyState } from '@/components/system';

import { useResponsiveSandboxSidebar } from '../../use-sandbox-layout';

import {
  HistoricalSandboxProvider,
  SandboxProvider,
  useTaskSession,
  useTaskCompletionNotification,
  useTaskMessageEnvelopes,
} from './hooks';

import { ProductTips, SnapshotResumeFailureFooter, Startup } from './startup';
import { DraftPromptBanner } from './DraftPromptBanner';
import { Header } from './Header';
import { HistoricalContent } from './HistoricalContent';
import { getTaskNotificationPhase } from './hooks/task-notification-phase';
import { MemoizedLiveContent } from './LiveContent';
import { TaskWorkspaceSkeleton } from './TaskWorkspaceSkeleton';

export default function SandboxPage() {
  const { taskId: unresolvedTaskId } = useParams<{ taskId: string }>();
  useResponsiveSandboxSidebar(unresolvedTaskId);

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
  const newTaskSearchParams = new URLSearchParams();

  if (startupPrompt?.text) {
    newTaskSearchParams.set('prompt', startupPrompt.text);
  }

  if (task?.model) {
    newTaskSearchParams.set('model', task.model);
  }

  const environmentId = getLinkedEnvironmentIdFromPayload(taskRun?.payload);

  if (environmentId) {
    newTaskSearchParams.set('environmentId', environmentId);
  }

  const newTaskQuery = newTaskSearchParams.toString();
  const newTaskHref = newTaskQuery ? `/?${newTaskQuery}` : '/';
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

  usePageTitle(truncatePageTitle(task?.title));

  useEffect(() => {
    if (sessionState !== 'interactive') {
      setLiveTaskPhase(null);
    }
  }, [sessionState]);

  // Refresh transcript history when the active run phase changes, or when
  // task activity advances (e.g. out-of-band PR self-review summaries written
  // while the page is open on an idle/historical session).
  const taskActivityAtMs =
    task?.activityAt == null
      ? null
      : typeof task.activityAt === 'number'
        ? task.activityAt
        : new Date(task.activityAt).getTime();

  useEffect(() => {
    if (!taskId) {
      return;
    }

    const historyRefreshSignal = [
      activeRunId ?? '',
      activeTaskRunStatus ?? '',
      activeTaskRunTaskPhase ?? '',
      taskActivityAtMs ?? '',
    ].join(':');

    if (historyRefreshSignal === lastHistoryRefreshSignalRef.current) {
      return;
    }

    // Skip the very first signal (initial load already fetches envelopes).
    if (lastHistoryRefreshSignalRef.current === null) {
      lastHistoryRefreshSignalRef.current = historyRefreshSignal;
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
    taskActivityAtMs,
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
    return <TaskWorkspaceSkeleton />;
  }

  if (sessionState === 'error') {
    return (
      <FramedSurface
        frameClassName="pb-0 md:pb-2"
        surfaceClassName="flex items-center justify-center"
      >
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
      <FramedSurface
        frameClassName="pb-0 md:pb-2"
        surfaceClassName="flex items-center justify-center"
      >
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
      <FramedSurface
        frameClassName="pb-0 md:pb-2"
        surfaceClassName="flex items-center justify-center"
      >
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
      >
        <HistoricalContent
          session={session}
          footer={
            taskRun ? (
              <SnapshotResumeFailureFooter
                taskRun={taskRun}
                newTaskHref={newTaskHref}
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            <Startup
              runId={taskRun.id}
              initialTaskRun={taskRun}
              newTaskHref={newTaskHref}
              onStatusChange={handleBootStatusChange}
            />
          </div>
        </div>
      </div>
    );
  }

  if (sessionState === 'booting' && !shouldRenderBootingTranscript) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Header session={session} />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            <Startup
              runId={taskRun.id}
              initialTaskRun={taskRun}
              newTaskHref={newTaskHref}
              onStatusChange={handleBootStatusChange}
            />
            <ProductTips />
          </div>
        </div>
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
    >
      <MemoizedLiveContent
        session={session}
        newTaskHref={newTaskHref}
        onBootStatusChange={handleBootStatusChange}
        onTaskPhaseChange={setLiveTaskPhase}
      />
    </SandboxProvider>
  );
}

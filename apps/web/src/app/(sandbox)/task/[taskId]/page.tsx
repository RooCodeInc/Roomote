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
import { CircleSlash } from '@/components/system';

import {
  TaskPayloadKind,
  DEFAULT_CODING_HARNESS,
  isExitedCloudTaskStatus,
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
  useCloudSession,
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

  const session = useCloudSession(unresolvedTaskId, {
    refetchInterval: 30_000,
  });

  const historyEnvelopesQuery = useTaskMessageEnvelopes(unresolvedTaskId, {
    enabled: true,
  });

  const [liveTaskPhase, setLiveTaskPhase] = useState<TaskPhase | null>(null);

  const { cloudJob, task, token, taskId, sessionState, isSessionLoading } =
    session;
  const lastHistoryRefreshSignalRef = useRef<string | null>(null);
  const activeCloudJobId = cloudJob?.id;
  const activeCloudJobStatus = cloudJob?.status;
  const activeCloudJobTaskPhase = cloudJob?.taskPhase;
  const hasTranscriptHistory = (historyEnvelopesQuery.data?.length ?? 0) > 0;
  const hasArtifacts = session.artifacts.length > 0;
  const hasVisibleSessionPrompt =
    session.prompt?.visibleInTranscript !== false && session.prompt != null;
  const shouldRenderBootingTranscript =
    sessionState === 'booting' &&
    (hasTranscriptHistory || hasVisibleSessionPrompt);
  const shouldRenderHistoricalBootFailure =
    cloudJob?.payloadKind === TaskPayloadKind.SnapshotResume &&
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
      !activeCloudJobId ||
      !activeCloudJobStatus ||
      sessionState !== 'interactive' ||
      isExitedCloudTaskStatus(activeCloudJobStatus)
    ) {
      return;
    }

    const historyRefreshSignal = [
      activeCloudJobId,
      activeCloudJobStatus,
      activeCloudJobTaskPhase ?? '',
    ].join(':');

    if (historyRefreshSignal === lastHistoryRefreshSignalRef.current) {
      return;
    }

    lastHistoryRefreshSignalRef.current = historyRefreshSignal;

    void queryClient.invalidateQueries({
      queryKey: trpc.tasks.messageEnvelopes.queryKey({ taskId }),
    });
  }, [
    activeCloudJobId,
    activeCloudJobStatus,
    activeCloudJobTaskPhase,
    queryClient,
    sessionState,
    taskId,
    trpc.tasks.messageEnvelopes,
  ]);

  const taskPhase = getTaskNotificationPhase({
    sessionState,
    liveTaskPhase,
    persistedTaskPhase: cloudJob?.taskPhase as TaskPhase | null | undefined,
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

  if (sessionState === 'historical' || sessionState === 'resuming') {
    return (
      <HistoricalSandboxProvider
        taskId={taskId}
        history={historyEnvelopesQuery}
        harness={cloudJob?.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={cloudJob?.status ?? null}
        taskPhase={
          (cloudJob?.taskPhase as TaskPhase | null | undefined) ?? null
        }
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
        harness={cloudJob?.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={cloudJob?.status ?? null}
        taskPhase={
          (cloudJob?.taskPhase as TaskPhase | null | undefined) ?? null
        }
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
            cloudJob ? (
              <SnapshotResumeFailureFooter cloudJob={cloudJob} />
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
          cloudJobId={cloudJob!.id}
          initialCloudJob={cloudJob!}
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
          cloudJobId={cloudJob!.id}
          initialCloudJob={cloudJob!}
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
      url={cloudJob!.sandboxServerUrl}
      token={token}
      refreshConnection={session.refreshConnection}
      history={historyEnvelopesQuery}
      initialTaskStatus={cloudJob?.status ?? null}
      initialTaskPhase={
        (cloudJob?.taskPhase as TaskPhase | null | undefined) ?? null
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

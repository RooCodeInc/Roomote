'use client';

import Link from 'next/link';

import { DEFAULT_CODING_HARNESS, type TaskPhase } from '@roomote/types';

import {
  Button,
  ErrorState,
  ExternalLink,
  Skeleton,
} from '@/components/system';

import { ArtifactLinkProvider } from '../../task/[taskId]/hooks/ArtifactLinkProvider';
import { HistoricalSandboxProvider } from '../../task/[taskId]/hooks/HistoricalSandboxProvider';
import { SandboxProvider } from '../../task/[taskId]/hooks/SandboxProvider';
import { useTaskMessageEnvelopes } from '../../task/[taskId]/hooks/use-task-message-envelopes';
import {
  useTaskSession,
  type TaskSession,
} from '../../task/[taskId]/hooks/use-task-session';
import { Messages } from '../../task/[taskId]/Messages';
import { SidePanelHeader } from '../../task/[taskId]/sidebar-panels/SidePanelHeader';

function NestedTaskTranscript({ session }: { session: TaskSession }) {
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

  const transcript = (
    <ArtifactLinkProvider session={session}>
      <Messages
        session={session}
        initialScrollBehavior="instant"
        conversationClassName="mx-auto w-full max-w-4xl p-4"
        messageUiOptions={{ displayMode: 'default' }}
      />
    </ArtifactLinkProvider>
  );

  if (
    session.sessionState === 'historical' ||
    session.sessionState === 'resuming' ||
    session.sessionState === 'boot-failed'
  ) {
    return (
      <HistoricalSandboxProvider
        taskId={session.taskId}
        history={history}
        harness={session.taskRun.harness ?? DEFAULT_CODING_HARNESS}
        taskStatus={session.taskRun.status}
        taskPhase={session.taskRun.taskPhase as TaskPhase | null | undefined}
      >
        {transcript}
      </HistoricalSandboxProvider>
    );
  }

  return (
    <SandboxProvider
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
      {transcript}
    </SandboxProvider>
  );
}

export function NestedTaskSidePanel({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const session = useTaskSession(taskId, { refetchInterval: 2_000 });
  const title = session.task?.title?.trim() || 'Task';

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <SidePanelHeader
        title={title}
        onClose={onClose}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/task/${taskId}`}>
              Go to task
              <ExternalLink />
            </Link>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <NestedTaskTranscript session={session} />
      </div>
    </div>
  );
}

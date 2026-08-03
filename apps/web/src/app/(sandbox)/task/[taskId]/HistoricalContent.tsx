'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RunStatus } from '@roomote/types';
import { MessageSquareWarning, RotateCcw } from 'lucide-react';
import { Button, Sun } from '@/components/system';
import { Message, MessageContent, Shimmer } from '@/components/ai-elements';
import { FramedSurface } from '@/components/layout';

import {
  type TaskSession,
  ArtifactLinkProvider,
  PreviewPaneProvider,
  TaskSidePanelProvider,
  useClosePreviewOnSleep,
  useSandboxMessages,
} from './hooks';
import { getTaskRunDisplayError } from '@/lib/task-run-errors';
import { canRelaunchFailedStart } from '@/lib/task-run-retry';
import { useRetryFailedTaskStart } from '@/hooks/task-runs';

import { SidebarActions } from './sidebar-actions';
import { isTaskRunAsleep } from './sidebar-actions/utils';
import { DraftPromptBanner } from './DraftPromptBanner';
import { Header } from './Header';
import { Messages } from './Messages';
import { PreviewCommand } from './PreviewCommand';
import { PreviewPaneLayout } from './PreviewPaneLayout';
import { WakeTaskInput } from './WakeTaskInput';
import { OnboardingCompletionMessage } from './OnboardingCompletionMessage';

interface HistoricalContentProps {
  session: TaskSession;
  footer?: ReactNode;
}

export function HistoricalContent({ session, footer }: HistoricalContentProps) {
  const isResuming = session.sessionState === 'resuming';
  const draftPrompt = session.draftPrompt;
  const isAsleep = isTaskRunAsleep(session.taskRun);
  const taskRun = session.taskRun;
  const onboardingEnvironment = session.onboardingEnvironment;
  const shouldShowWakeTaskInput = isAsleep && Boolean(taskRun?.snapshotId);
  const [messagesInitialScrollBehavior, setMessagesInitialScrollBehavior] =
    useState<'smooth' | 'instant'>('smooth');
  const retryFailedStart = useRetryFailedTaskStart();
  const { messages } = useSandboxMessages();
  const taskFailureFooter = useMemo(() => {
    const displayError = getTaskRunDisplayError(taskRun);

    if (
      !taskRun ||
      !displayError ||
      (taskRun.status !== RunStatus.Failed &&
        taskRun.status !== RunStatus.Canceled)
    ) {
      return null;
    }

    // `enqueueTaskRelaunch` refuses a run that already has non-kickoff
    // messages, because relaunching would redo work the run already did —
    // a review it posted would post twice. So the retry is only offered
    // for a start that failed with an empty transcript; a run whose
    // sandbox came up late keeps its output and is not retryable here (the
    // provisioning deadline is what keeps it from failing in the first
    // place). Gating on an empty transcript rather than on message source
    // is deliberately stricter than the server: it can hide the button for
    // a kickoff-only run, which the startup view still offers, and it can
    // never show a button that would only raise an error.
    const canRetry = canRelaunchFailedStart(taskRun) && messages.length === 0;

    return (
      <TaskFailureMessage
        error={displayError}
        onRetry={
          canRetry
            ? () =>
                retryFailedStart.mutate({
                  taskId: session.taskId,
                  runId: taskRun.id,
                })
            : undefined
        }
        retryPending={retryFailedStart.isPending}
      />
    );
  }, [messages.length, retryFailedStart, session.taskId, taskRun]);
  const messagesFooter = useMemo(() => {
    const onboardingCompletionFooter = onboardingEnvironment ? (
      <OnboardingCompletionMessage environment={onboardingEnvironment} />
    ) : null;

    return (
      <>
        {isResuming ? <WakingUpMessage /> : null}
        {footer ?? taskFailureFooter ?? onboardingCompletionFooter}
      </>
    );
  }, [footer, isResuming, onboardingEnvironment, taskFailureFooter]);

  useEffect(() => {
    setMessagesInitialScrollBehavior('instant');
  }, []);

  return (
    <TaskSidePanelProvider
      taskId={session.taskId}
      artifacts={session.artifacts}
    >
      <PreviewPaneProvider>
        <ClosePreviewOnSleepEffect asleep={isAsleep} />
        <div className="flex h-full min-h-0 min-w-0 flex-1">
          <FramedSurface surfaceClassName="flex flex-col bg-transparent @container">
            <PreviewPaneLayout session={session}>
              <ArtifactLinkProvider session={session}>
                <PreviewCommand
                  taskRun={session.taskRun ?? null}
                  asleep={isAsleep}
                />
                <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
                  <Header session={session} />
                  <Messages
                    session={session}
                    initialScrollBehavior={messagesInitialScrollBehavior}
                    footer={messagesFooter}
                  />
                  {shouldShowWakeTaskInput && taskRun ? (
                    <HistoricalInputTray>
                      <WakeTaskInput
                        taskRun={taskRun}
                        initialPrompt={draftPrompt ?? ''}
                        embedded
                      />
                    </HistoricalInputTray>
                  ) : isResuming && draftPrompt ? (
                    <HistoricalInputTray>
                      <DraftPromptBanner draftPrompt={draftPrompt} embedded />
                    </HistoricalInputTray>
                  ) : null}
                </div>
              </ArtifactLinkProvider>
            </PreviewPaneLayout>
          </FramedSurface>
          <SidebarActions session={session} />
        </div>
      </PreviewPaneProvider>
    </TaskSidePanelProvider>
  );
}

function HistoricalInputTray({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full overflow-clip rounded-t-md bg-card @[56rem]:rounded-t-lg transition-colors border-2 border-background rounded-b-3xl">
      {children}
    </div>
  );
}

function ClosePreviewOnSleepEffect({ asleep }: { asleep: boolean }) {
  useClosePreviewOnSleep(asleep);
  return null;
}

function WakingUpMessage() {
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex items-center gap-2 text-sm">
          <Sun className="size-4 shrink-0 text-muted-foreground" />
          <Shimmer direction="rl" duration={1}>
            Waking up
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

function TaskFailureMessage({
  error,
  onRetry,
  retryPending = false,
}: {
  error: string;
  onRetry?: (() => void) | undefined;
  retryPending?: boolean;
}) {
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex items-start gap-2 text-sm text-destructive animate-in fade-in duration-300">
          <MessageSquareWarning className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <div>Task ended because of an error:</div>
            <div className="text-foreground whitespace-pre-wrap wrap-break-word">
              {error}
            </div>
            {onRetry && (
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  disabled={retryPending}
                >
                  <RotateCcw className="size-4" />
                  Retry
                </Button>
              </div>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

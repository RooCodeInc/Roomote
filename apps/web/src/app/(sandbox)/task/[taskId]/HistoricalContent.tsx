'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RunStatus } from '@roomote/types';
import { MessageSquareWarning } from 'lucide-react';
import { Sun } from '@/components/system';
import { Message, MessageContent, Shimmer } from '@/components/ai-elements';
import { FramedSurface } from '@/components/layout';

import {
  type CloudSession,
  ArtifactLinkProvider,
  PreviewPaneProvider,
  TaskSidePanelProvider,
  useClosePreviewOnSleep,
} from './hooks';
import { getCloudJobDisplayError } from '@/lib/cloud-job-errors';

import { SidebarActions } from './sidebar-actions';
import { isCloudJobAsleep } from './sidebar-actions/utils';
import { DraftPromptBanner } from './DraftPromptBanner';
import { Header } from './Header';
import { Messages } from './Messages';
import { PreviewCommand } from './PreviewCommand';
import { PreviewPaneLayout } from './PreviewPaneLayout';
import { WakeTaskInput } from './WakeTaskInput';

interface HistoricalContentProps {
  session: CloudSession;
  footer?: ReactNode;
}

export function HistoricalContent({ session, footer }: HistoricalContentProps) {
  const isResuming = session.sessionState === 'resuming';
  const draftPrompt = session.draftPrompt;
  const isAsleep = isCloudJobAsleep(session.cloudJob);
  const cloudJob = session.cloudJob;
  const shouldShowWakeTaskInput = isAsleep && Boolean(cloudJob?.snapshotId);
  const [messagesInitialScrollBehavior, setMessagesInitialScrollBehavior] =
    useState<'smooth' | 'instant'>('smooth');
  const taskFailureFooter = useMemo(() => {
    const displayError = getCloudJobDisplayError(cloudJob);

    if (
      !cloudJob ||
      !displayError ||
      (cloudJob.status !== RunStatus.Failed &&
        cloudJob.status !== RunStatus.Canceled)
    ) {
      return null;
    }

    return <TaskFailureMessage error={displayError} />;
  }, [cloudJob]);
  const messagesFooter = useMemo(
    () => (
      <>
        {isResuming ? <WakingUpMessage /> : null}
        {footer ?? taskFailureFooter}
      </>
    ),
    [footer, isResuming, taskFailureFooter],
  );

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
          <FramedSurface surfaceClassName="flex flex-col bg-transparent">
            <PreviewPaneLayout session={session}>
              <ArtifactLinkProvider session={session}>
                <PreviewCommand
                  cloudJob={session.cloudJob ?? null}
                  asleep={isAsleep}
                />
                <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
                  <Header session={session} />
                  <Messages
                    session={session}
                    initialScrollBehavior={messagesInitialScrollBehavior}
                    footer={messagesFooter}
                  />
                  {shouldShowWakeTaskInput && cloudJob ? (
                    <WakeTaskInput
                      cloudJob={cloudJob}
                      initialPrompt={draftPrompt ?? ''}
                    />
                  ) : (
                    isResuming &&
                    draftPrompt && (
                      <DraftPromptBanner draftPrompt={draftPrompt} />
                    )
                  )}
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

function TaskFailureMessage({ error }: { error: string }) {
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
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

'use client';

import type { CloudSession } from './hooks/use-cloud-session';
import {
  PendingUserInputRequestPanel,
  usePendingUserInputRequestState,
} from './PendingUserInputRequestPanel';
import { PendingEnvVarRequestPanel } from './PendingEnvVarRequestPanel';
import { PromptInput, type PromptInputHandle } from './prompt-input';
import { QueuedMessages } from './QueuedMessages';
import { Startup } from './startup';
import { ActiveSubtasksList } from './ActiveSubtasksList';
import { TodoList } from './TodoList';

export function TaskInputStack({
  session,
  promptInputRef,
  onFileSearchOpen,
  onCommandSearchOpen,
  onBootStatusChange,
  scrollToBottom,
}: {
  session: CloudSession;
  promptInputRef: { current: PromptInputHandle | null };
  onFileSearchOpen: (insertPosition?: number) => void;
  onCommandSearchOpen: (insertPosition?: number) => void;
  onBootStatusChange?: () => void;
  scrollToBottom: () => void;
}) {
  const { shouldHidePromptInput } = usePendingUserInputRequestState();
  const bootingCloudJob =
    session.sessionState === 'booting' ? session.cloudJob : null;

  return (
    <>
      <TodoList taskEntryKey={session.taskId} />
      <ActiveSubtasksList taskEntryKey={session.taskId} />
      <PendingUserInputRequestPanel />
      <PendingEnvVarRequestPanel taskId={session.taskId} />
      <QueuedMessages />
      {bootingCloudJob ? (
        <div className="flex max-h-[50vh] min-h-0 flex-col">
          <Startup
            cloudJobId={bootingCloudJob.id}
            initialCloudJob={bootingCloudJob}
            onStatusChange={onBootStatusChange}
          />
        </div>
      ) : (
        <div className={shouldHidePromptInput ? 'hidden' : undefined}>
          <PromptInput
            ref={promptInputRef}
            initialPrompt={session.draftPrompt ?? ''}
            onFileSearchOpen={onFileSearchOpen}
            onCommandSearchOpen={onCommandSearchOpen}
            cloudJob={session.cloudJob}
            hasTransportError={session.hasTransportError}
            scrollToBottom={scrollToBottom}
          />
        </div>
      )}
    </>
  );
}

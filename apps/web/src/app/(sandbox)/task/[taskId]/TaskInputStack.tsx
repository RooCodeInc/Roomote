'use client';

import type { TaskSession } from './hooks/use-task-session';
import {
  PendingUserInputRequestPanel,
  usePendingUserInputRequestState,
} from './PendingUserInputRequestPanel';
import { PendingEnvVarRequestPanel } from './PendingEnvVarRequestPanel';
import { PromptInput, type PromptInputHandle } from './prompt-input';
import { QueuedMessages } from './QueuedMessages';
import { ActiveSubtasksList } from './ActiveSubtasksList';

export function TaskInputStack({
  session,
  promptInputRef,
  onFileSearchOpen,
  onCommandSearchOpen,
  scrollToBottom,
  promptPlaceholder,
  autoFocus,
}: {
  session: TaskSession;
  promptInputRef: { current: PromptInputHandle | null };
  onFileSearchOpen: (insertPosition?: number) => void;
  onCommandSearchOpen: (insertPosition?: number) => void;
  scrollToBottom: () => void;
  promptPlaceholder?: string;
  autoFocus?: boolean;
}) {
  const { shouldHidePromptInput } = usePendingUserInputRequestState();
  const isBooting = session.sessionState === 'booting';

  return (
    <>
      <ActiveSubtasksList taskEntryKey={session.taskId} />
      <PendingUserInputRequestPanel />
      <PendingEnvVarRequestPanel taskId={session.taskId} />
      <QueuedMessages />
      {!isBooting && (
        <div className={shouldHidePromptInput ? 'hidden' : undefined}>
          <PromptInput
            ref={promptInputRef}
            initialPrompt={session.draftPrompt ?? ''}
            onFileSearchOpen={onFileSearchOpen}
            onCommandSearchOpen={onCommandSearchOpen}
            taskRun={session.taskRun}
            hasTransportError={session.hasTransportError}
            scrollToBottom={scrollToBottom}
            placeholder={promptPlaceholder}
            autoFocus={autoFocus}
          />
        </div>
      )}
    </>
  );
}

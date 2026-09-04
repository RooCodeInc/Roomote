'use client';

import { useEffect, useState } from 'react';

import type { TaskSession } from './hooks/use-task-session';
import {
  PendingUserInputRequestPanel,
  usePendingUserInputRequestState,
} from './PendingUserInputRequestPanel';
import { PendingEnvVarRequestPanel } from './PendingEnvVarRequestPanel';
import { PromptInput, type PromptInputHandle } from './prompt-input';
import { QueuedMessages } from './QueuedMessages';
import { ActiveSubtasksList } from './ActiveSubtasksList';
import { TodoList } from './TodoList';

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
  const [visibleEnvVarRequestKey, setVisibleEnvVarRequestKey] = useState<
    string | null
  >(null);
  const isBooting = session.sessionState === 'booting';

  useEffect(() => {
    setVisibleEnvVarRequestKey(null);
  }, [session.taskId]);

  return (
    <>
      <TodoList
        autoCollapseKey={visibleEnvVarRequestKey}
        taskEntryKey={session.taskId}
      />
      <ActiveSubtasksList taskEntryKey={session.taskId} />
      <PendingUserInputRequestPanel />
      <PendingEnvVarRequestPanel
        taskId={session.taskId}
        onVisibleRequestKeyChange={setVisibleEnvVarRequestKey}
      />
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

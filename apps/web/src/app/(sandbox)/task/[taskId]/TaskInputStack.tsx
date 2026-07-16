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
  session: TaskSession;
  promptInputRef: { current: PromptInputHandle | null };
  onFileSearchOpen: (insertPosition?: number) => void;
  onCommandSearchOpen: (insertPosition?: number) => void;
  onBootStatusChange?: () => void;
  scrollToBottom: () => void;
}) {
  const { shouldHidePromptInput } = usePendingUserInputRequestState();
  const [visibleEnvVarRequestKey, setVisibleEnvVarRequestKey] = useState<
    string | null
  >(null);
  const bootingTaskRun =
    session.sessionState === 'booting' ? session.taskRun : null;

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
      {bootingTaskRun ? (
        <div className="mx-auto flex max-h-[50vh] min-h-0 w-full max-w-4xl flex-col">
          <Startup
            runId={bootingTaskRun.id}
            taskId={session.taskId}
            initialTaskRun={bootingTaskRun}
            prompt={
              session.prompt && session.prompt.visibleInTranscript !== false
                ? {
                    text: session.prompt.text,
                    images: session.prompt.images,
                  }
                : null
            }
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
            taskRun={session.taskRun}
            hasTransportError={session.hasTransportError}
            scrollToBottom={scrollToBottom}
          />
        </div>
      )}
    </>
  );
}

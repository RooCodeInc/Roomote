'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { ReasoningEffort } from '@roomote/types';

import { ROOMOTE_FILE_ATTACHMENT_ACCEPT } from '@/lib/prompt-attachments';
import { useUser } from '@/hooks/useUser';
import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import {
  SUGGESTION_MIN_HISTORY_MESSAGES,
  useGhostSuggestion,
} from '@/hooks/useGhostSuggestion';
import {
  type PromptInputMessage,
  PromptInput as PromptInputRoot,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  VoiceDictationButton,
  usePromptInputAttachments,
} from '@/components/ai-elements';
import { BasicTooltip } from '@/components/system';
import { useTRPC, useTRPCClient } from '@/trpc/client';

import { AttachmentsDisplay } from '../../task/[taskId]/prompt-input/AttachmentsDisplay';
import { SessionModelSwitcher } from './SessionModelSwitcher';

export type SessionPromptSubmission = PromptInputMessage & {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

function SessionSubmit({
  sending,
  prompt,
}: {
  sending: boolean;
  prompt: string;
}) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;

  return (
    <PromptInputSubmit
      disabled={sending || (!prompt.trim() && !hasAttachments)}
    />
  );
}

/** Session reply composer mirroring the task composer's structure: action
 * menu and model switcher on the left, voice and submit on the right. */
export function SessionPromptInput({
  sessionId,
  isBusy,
  onSend,
  historyMessageCount = 0,
  assistantMessageCount = 0,
  taskStateRevision = '',
  agentWorking = false,
  initialModel = null,
  initialReasoningEffort = null,
  defaultModelId = null,
  defaultReasoningEffort = null,
}: {
  sessionId: string;
  isBusy: boolean;
  onSend: (submission: SessionPromptSubmission) => Promise<boolean>;
  /** Persisted user/assistant messages with text; gates suggestions. */
  historyMessageCount?: number;
  /** Persisted assistant messages with text; each completed agent turn
   * advances the suggestion query key. */
  assistantMessageCount?: number;
  /** Fingerprint of the delegated tasks' state; a task finishing while the
   * session is idle refreshes the suggestion through this key. */
  taskStateRevision?: string;
  /** True while the agent is still responding; suggestions only exist while
   * the agent is waiting for the human. */
  agentWorking?: boolean;
  initialModel?: string | null;
  initialReasoningEffort?: ReasoningEffort | null;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
}) {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const [prompt, setPrompt] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [model, setModel] = useState(initialModel ?? '');
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(initialReasoningEffort);
  const [isUpdatingModelSelection, setIsUpdatingModelSelection] =
    useState(false);
  const voiceDictation = useVoiceDictation({
    onTranscript: (text) => setPrompt(text),
    getPrefix: () => prompt,
    disabled: isBusy,
  });

  // Experimental, deployment-wide opt-in. The server enforces the flag too;
  // this just avoids pointless requests while it is off.
  const { user } = useUser();
  const suggestionsEnabled = user?.featureFlags?.composerSuggestions === true;

  const composerSuggestionQuery = useQuery(
    trpc.fastSessions.composerSuggestion.queryOptions(
      {
        sessionId,
        historyRevision: assistantMessageCount,
        taskStateRevision: taskStateRevision || undefined,
      },
      {
        // The mid-turn gate matters here too: assistant messages land while
        // the agent is still working, and each would otherwise generate and
        // surface a premature suggestion.
        enabled:
          suggestionsEnabled &&
          !agentWorking &&
          historyMessageCount >= SUGGESTION_MIN_HISTORY_MESSAGES,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
    ),
  );
  const suggestion = composerSuggestionQuery.data?.suggestion?.trim() || null;
  const {
    ghostSuggestion,
    suggestionHintId,
    acceptGhostSuggestion,
    consumeSuggestion,
    handleSuggestionKeyDown,
  } = useGhostSuggestion({
    suggestion,
    active: !prompt && !isBusy && !isUpdatingModelSelection && !agentWorking,
    surface: 'session',
    onAccept: (text) => setPrompt(text),
  });

  const handleSubmit = async (message: PromptInputMessage) => {
    if (isBusy || isUpdatingModelSelection) {
      return;
    }

    consumeSuggestion();

    // Always send the current picker state: it round-trips the persisted
    // choice and clears it when the picker is reset to the default. The
    // draft and attachments are only cleared once the send succeeds, so a
    // failed reply is not lost.
    const sent = await onSend({
      ...message,
      model: model || null,
      reasoningEffort,
    });
    if (sent) {
      setPrompt('');
      // Remount the root to clear held attachments.
      setResetKey((previous) => previous + 1);
    }
  };

  const updateModelSelection = async (
    next: { model?: string | null; reasoningEffort?: ReasoningEffort | null },
    rollback: () => void,
  ) => {
    setIsUpdatingModelSelection(true);
    try {
      await trpcClient.fastSessions.updateModelSelection.mutate({
        sessionId,
        ...next,
      });
    } catch (error) {
      rollback();
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to update the model settings',
      );
    } finally {
      setIsUpdatingModelSelection(false);
    }
  };

  const handleModelChange = (nextModel: string) => {
    const previousModel = model;
    setModel(nextModel);
    void updateModelSelection({ model: nextModel || null }, () =>
      setModel(previousModel),
    );
  };

  const handleReasoningEffortChange = (
    nextReasoningEffort: ReasoningEffort | null,
  ) => {
    const previousReasoningEffort = reasoningEffort;
    setReasoningEffort(nextReasoningEffort);
    void updateModelSelection({ reasoningEffort: nextReasoningEffort }, () =>
      setReasoningEffort(previousReasoningEffort),
    );
  };

  const controlsDisabled = isBusy || isUpdatingModelSelection;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PromptInputRoot
        key={`composer-${resetKey}`}
        onSubmit={handleSubmit}
        accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
        clearOnSubmit={false}
        multiple
      >
        <AttachmentsDisplay />
        <PromptInputBody>
          <div className="relative">
            <PromptInputTextarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                handleSuggestionKeyDown(event);
              }}
              placeholder={ghostSuggestion ?? 'Message agent'}
              aria-describedby={ghostSuggestion ? suggestionHintId : undefined}
              disabled={isBusy}
            />
            {ghostSuggestion && (
              <>
                <span id={suggestionHintId} className="sr-only">
                  Suggested message: {ghostSuggestion}. Press Tab to accept or
                  Escape to dismiss.
                </span>
                <button
                  type="button"
                  aria-label="Insert suggested message"
                  onClick={acceptGhostSuggestion}
                  className="absolute right-4 top-4 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                >
                  Tab
                </button>
              </>
            )}
          </div>
        </PromptInputBody>
        <PromptInputFooter className="px-4 pt-0 pb-4">
          <PromptInputTools>
            <PromptInputActionMenu>
              <BasicTooltip content="Add to session">
                <PromptInputActionMenuTrigger
                  aria-label="Add to session"
                  className="hover:bg-secondary"
                />
              </BasicTooltip>
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <SessionModelSwitcher
              model={model}
              onModelChange={handleModelChange}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={handleReasoningEffortChange}
              defaultModelId={defaultModelId}
              defaultReasoningEffort={defaultReasoningEffort}
              disabled={controlsDisabled}
            />
          </PromptInputTools>
          <div className="flex items-center gap-2">
            <VoiceDictationButton
              isRecording={voiceDictation.isRecording}
              isSupported={voiceDictation.isSupported}
              onClick={voiceDictation.toggle}
              disabled={isBusy}
            />
            <SessionSubmit sending={controlsDisabled} prompt={prompt} />
          </div>
        </PromptInputFooter>
      </PromptInputRoot>
    </div>
  );
}

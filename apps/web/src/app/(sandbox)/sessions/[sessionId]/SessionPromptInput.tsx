'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { ReasoningEffort } from '@roomote/types';

import { ROOMOTE_FILE_ATTACHMENT_ACCEPT } from '@/lib/prompt-attachments';
import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import type { LiveVoiceStatus } from '@/hooks/useLiveVoice';
import { useAutoFocusOnce } from '@/hooks/useAutoFocusOnce';
import {
  useSessionDraft,
  useSessionNavigationState,
} from '@/hooks/useSessionNavigationState';
import {
  SUGGESTION_MIN_HISTORY_MESSAGES,
  useGhostSuggestion,
} from '@/hooks/useGhostSuggestion';
import {
  LiveVoiceButton,
  PromptInput as PromptInputRoot,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  VoiceDictationButton,
  usePromptInputAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements';
import {
  AudioLines,
  BasicTooltip,
  Volume2,
  VolumeX,
  X,
} from '@/components/system';
import { SessionModelSwitcher } from '@/components/tasks/SessionModelSwitcher';
import { useSessionIntegrationMentions } from '@/components/tasks/useSessionIntegrationMentions';
import { useTRPC, useTRPCClient } from '@/trpc/client';

import { AttachmentsDisplay } from '../../task/[taskId]/prompt-input/AttachmentsDisplay';
import { SessionWakeups } from './SessionWakeups';

export type SessionPromptSubmission = PromptInputMessage & {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  integrationIds?: string[];
};

export type SessionModelSelection = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

type SessionVoiceControls = {
  /** Whether the deployment has voice configured at all. */
  enabled: boolean;
  /** Whether a voice conversation is currently running. */
  active: boolean;
  status: LiveVoiceStatus;
  onToggle: () => void;
  /** In-call controls, present while the call is connected. */
  call?: {
    startedAt: number | null;
    inputLevel: number;
    micMuted: boolean;
    onToggleMic: () => void;
    outputMuted: boolean;
    onToggleOutput: () => void;
  };
};

function formatCallTimer(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Elapsed call time, ticking once a second while the call is connected. */
function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  return (
    <span
      className="tabular-nums text-xs text-muted-foreground"
      aria-label="Call duration"
    >
      {formatCallTimer(now - startedAt)}
    </span>
  );
}

function VoiceLevel({ level, muted }: { level: number; muted: boolean }) {
  const bars = [0.45, 0.7, 1, 0.75, 0.5];
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={muted ? 0 : Math.round(level * 100)}
      className="flex h-8 items-center gap-1"
    >
      {bars.map((weight, index) => (
        <span
          key={index}
          className="w-1 rounded-full bg-primary transition-[height,opacity] duration-100"
          style={{
            height: `${Math.max(4, (muted ? 0 : level) * weight * 28)}px`,
            opacity: muted ? 0.25 : 0.45 + level * 0.55,
          }}
        />
      ))}
    </div>
  );
}

function AudioLinesX() {
  // The pinned Lucide version has no native AudioLinesX export.
  return (
    <span className="relative size-4">
      <AudioLines className="size-4" />
      <X className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background stroke-[2.5]" />
    </span>
  );
}

function VoiceConversationPanel({ voice }: { voice: SessionVoiceControls }) {
  const call = voice.call;
  const connected = voice.status === 'listening' || voice.status === 'speaking';

  return (
    <div className="flex min-h-20 w-full items-center justify-between gap-3 px-4 py-3 sm:min-h-24 sm:px-6">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {voice.status === 'connecting'
            ? 'Connecting voice...'
            : voice.status === 'speaking'
              ? 'Roomote is speaking'
              : 'Listening'}
        </p>
        {call?.startedAt != null ? (
          <CallTimer startedAt={call.startedAt} />
        ) : (
          <span className="text-xs text-muted-foreground">Starting call</span>
        )}
      </div>
      <div className="flex flex-1 items-center justify-center">
        <VoiceLevel
          level={call?.inputLevel ?? 0}
          muted={!connected || Boolean(call?.micMuted)}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {call && connected ? (
          <>
            <BasicTooltip
              content={call.micMuted ? 'Unmute your voice' : 'Mute your voice'}
            >
              <PromptInputButton
                aria-label={
                  call.micMuted ? 'Unmute your voice' : 'Mute your voice'
                }
                aria-pressed={call.micMuted}
                onClick={call.onToggleMic}
                className="rounded-full"
              >
                {call.micMuted ? <AudioLinesX /> : <AudioLines />}
              </PromptInputButton>
            </BasicTooltip>
            <BasicTooltip
              content={
                call.outputMuted ? 'Unsilence Roomote' : 'Silence Roomote'
              }
            >
              <PromptInputButton
                aria-label={
                  call.outputMuted ? 'Unsilence Roomote' : 'Silence Roomote'
                }
                aria-pressed={call.outputMuted}
                onClick={call.onToggleOutput}
                className="rounded-full"
              >
                {call.outputMuted ? <VolumeX /> : <Volume2 />}
              </PromptInputButton>
            </BasicTooltip>
          </>
        ) : null}
        <LiveVoiceButton active onClick={voice.onToggle} />
      </div>
    </div>
  );
}

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
  voice,
  onModelSelectionChange,
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
  voice?: SessionVoiceControls;
  /** Keeps the parent's view of the picker current, so voice utterances
   * round-trip the same model selection a typed reply would. */
  onModelSelectionChange?: (selection: SessionModelSelection) => void;
}) {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const { draft: prompt, setDraft: setPrompt } = useSessionDraft(sessionId);
  const navigationState = useSessionNavigationState();
  const [shouldAutoFocus] = useState(
    () => !navigationState?.consumeSessionSwitch(sessionId),
  );
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const [model, setModel] = useState(initialModel ?? '');
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(initialReasoningEffort);
  const [isUpdatingModelSelection, setIsUpdatingModelSelection] =
    useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const integrationMentions = useSessionIntegrationMentions({
    sessionId,
    value: prompt,
    onValueChange: setPrompt,
    textareaRef,
  });
  useAutoFocusOnce(textareaRef, !isBusy && shouldAutoFocus);
  const voiceDictation = useVoiceDictation({
    onTranscript: (text) => setPrompt(text),
    getPrefix: () => prompt,
    disabled: isBusy || Boolean(voice?.active),
  });

  const handleVoiceToggle = () => {
    if (!voice?.active) voiceDictation.stop();
    voice?.onToggle();
  };

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
      return false;
    }

    consumeSuggestion();

    const goalMatch = /^\/goal(?:\s+([\s\S]*))?$/i.exec(message.text.trim());
    let sent: boolean;
    if (goalMatch) {
      const objective = goalMatch[1]?.trim();
      if (!objective) {
        toast.error('Describe the goal after /goal.');
        return false;
      }
      if (message.files.length > 0) {
        toast.error('Goal Mode does not support attachments.');
        return false;
      }
      const result = await trpcClient.fastSessions.startGoal.mutate({
        sessionId,
        objective,
      });
      if (!result.success) {
        toast.error(result.error);
        return false;
      }
      toast.success(`Pursuing goal: ${objective}`);
      sent = true;
    } else {
      const integrationIds = integrationMentions.getSelectedIntegrationIds(
        message.text,
      );
      // Always send the current picker state: it round-trips the persisted
      // choice and clears it when the picker is reset to the default.
      sent = await onSend({
        ...message,
        model: model || null,
        reasoningEffort,
        ...(integrationIds.length > 0 ? { integrationIds } : {}),
      });
    }
    if (sent) {
      setPrompt('');
      integrationMentions.resetSelectedIntegrations();
    }
    return sent;
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
    onModelSelectionChange?.({ model: nextModel || null, reasoningEffort });
    void updateModelSelection({ model: nextModel || null }, () => {
      setModel(previousModel);
      onModelSelectionChange?.({
        model: previousModel || null,
        reasoningEffort,
      });
    });
  };

  const handleReasoningEffortChange = (
    nextReasoningEffort: ReasoningEffort | null,
  ) => {
    const previousReasoningEffort = reasoningEffort;
    setReasoningEffort(nextReasoningEffort);
    onModelSelectionChange?.({
      model: model || null,
      reasoningEffort: nextReasoningEffort,
    });
    void updateModelSelection({ reasoningEffort: nextReasoningEffort }, () => {
      setReasoningEffort(previousReasoningEffort);
      onModelSelectionChange?.({
        model: model || null,
        reasoningEffort: previousReasoningEffort,
      });
    });
  };

  const controlsDisabled = isBusy || isUpdatingModelSelection;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <SessionWakeups key={sessionId} sessionId={sessionId} />
      <PromptInputRoot
        onSubmit={handleSubmit}
        accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
        keepFocusOnSubmit
        multiple
      >
        {!voice?.active ? <AttachmentsDisplay /> : null}
        <PromptInputBody>
          {integrationMentions.suggestions}
          {voice?.active ? (
            <VoiceConversationPanel
              voice={{ ...voice, onToggle: handleVoiceToggle }}
            />
          ) : (
            <div className="flex items-start">
              <PromptInputTextarea
                className="min-w-0 flex-1"
                ref={textareaRef}
                value={prompt}
                onChange={(event) =>
                  integrationMentions.handleValueChange(
                    event.target.value,
                    event.target.selectionStart,
                  )
                }
                onSelect={(event) =>
                  integrationMentions.handleCursorChange(
                    event.currentTarget.selectionStart,
                  )
                }
                onClick={(event) =>
                  integrationMentions.handleCursorChange(
                    event.currentTarget.selectionStart,
                  )
                }
                onFocus={() => {
                  setIsTextareaFocused(true);
                  integrationMentions.handleFocus();
                }}
                onBlur={() => {
                  setIsTextareaFocused(false);
                  integrationMentions.handleBlur();
                }}
                onKeyDown={(event) => {
                  if (integrationMentions.handleKeyDown(event)) return;
                  handleSuggestionKeyDown(event);
                }}
                placeholder={ghostSuggestion ?? 'Message agent'}
                aria-describedby={
                  ghostSuggestion ? suggestionHintId : undefined
                }
                disabled={isBusy}
                {...integrationMentions.inputProps}
              />
              {ghostSuggestion && (
                <>
                  <span id={suggestionHintId} className="sr-only">
                    Suggested message: {ghostSuggestion}. Press Tab to accept or
                    Escape to dismiss.
                  </span>
                  {isTextareaFocused && (
                    <button
                      type="button"
                      aria-label="Insert suggested message"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={acceptGhostSuggestion}
                      className="mt-4 mr-4 shrink-0 whitespace-nowrap rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                    >
                      <span className="md:hidden">Accept</span>
                      <span className="hidden md:inline">Tab to accept</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </PromptInputBody>
        {!voice?.active ? (
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
              {voice?.enabled ? (
                <LiveVoiceButton
                  active={voice.active}
                  onClick={handleVoiceToggle}
                  disabled={isBusy && !voice.active}
                />
              ) : null}
              <VoiceDictationButton
                isRecording={voiceDictation.isRecording}
                isSupported={voiceDictation.isSupported}
                onClick={voiceDictation.toggle}
                disabled={isBusy}
              />
              <SessionSubmit sending={controlsDisabled} prompt={prompt} />
            </div>
          </PromptInputFooter>
        ) : null}
      </PromptInputRoot>
    </div>
  );
}

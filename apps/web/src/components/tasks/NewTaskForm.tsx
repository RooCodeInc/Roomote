'use client';

import { useState, useCallback, useEffect, useRef, type Ref } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  type ReasoningEffort,
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
} from '@roomote/types';

import { preparePromptAttachments } from '@/lib/prompt-attachments';
import { getTaskLaunchDisabledReason } from '@/lib/managed-access';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useFastSessionLauncher } from '@/hooks/task-runs';
import { useVoiceEnabled } from '@/hooks/useVoiceEnabled';
import { usePrivateSessionsExperiment } from '@/hooks/usePrivateSessionsExperiment';

import { type PromptInputMessage } from '@/components/ai-elements';
import { SessionModelSwitcher, TaskPromptInput } from '@/components/tasks';
import {
  BasicTooltip,
  Button,
  HatGlasses,
  RetryableLoadError,
} from '@/components/system';

const DEFAULT_PROMPT_PLACEHOLDER = 'What do you want to do?';

type SubmissionSnapshot = {
  description?: string;
  images?: string[];
  attachmentTexts?: string[];
};

type NewTaskFormProps = {
  animate?: boolean;
  onTaskStarted?: () => void;
  initialPrompt?: string;
  placeholder?: string;
  promptSuggestion?: string;
  onPromptFocusChange?: (focused: boolean) => void;
  autoFocus?: boolean;
  textareaMaxHeight?: number;
  promptContainerRef?: Ref<HTMLDivElement>;
};

export function NewTaskForm({
  animate = true,
  onTaskStarted,
  initialPrompt = '',
  placeholder = DEFAULT_PROMPT_PLACEHOLDER,
  promptSuggestion,
  onPromptFocusChange,
  autoFocus = true,
  textareaMaxHeight,
  promptContainerRef,
}: NewTaskFormProps) {
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();

  const searchParams = useSearchParams();
  const promptParam = searchParams.get('prompt') ?? '';
  const modelParam = searchParams.get('model')?.trim() || undefined;

  const initialPromptText = promptParam || initialPrompt;
  const [promptText, setPromptText] = useState(initialPromptText);
  const [selectedModelOverrideId, setSelectedModelOverrideId] = useState<
    string | undefined
  >(modelParam);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<
    ReasoningEffort | null | undefined
  >(undefined);
  const [privateSession, setPrivateSession] = useState(
    searchParams.get('private') === '1',
  );
  const { enabled: privateSessionsEnabled } = usePrivateSessionsExperiment();
  const privateModeActive = privateSessionsEnabled && privateSession;

  useEffect(() => setPromptText(initialPromptText), [initialPromptText]);
  useEffect(() => setSelectedModelOverrideId(modelParam), [modelParam]);

  const {
    error: fastSessionError,
    isPending: isFastSessionPending,
    retryFastSession,
    startFastSession,
  } = useFastSessionLauncher({
    onSessionStarted: onTaskStarted,
    showErrorToast: false,
  });
  const launchTaskModels = useLaunchTaskModels();
  const defaultModelId = launchTaskModels.data?.defaultFastModelId;
  const defaultReasoningEffort =
    launchTaskModels.data?.defaultFastReasoningEffort;

  const isBusy = isFastSessionPending;

  const submitDisabledReason = getTaskLaunchDisabledReason(managedAccess);

  // --- Voice-started sessions ----------------------------------------------
  // A session needs content to exist, so the composer listens for the first
  // utterance here, starts the session with it, and hands the conversation
  // to the session page (which resumes voice and speaks the reply).
  const voiceEnabled = useVoiceEnabled();
  const startFastSessionRef = useRef(startFastSession);
  startFastSessionRef.current = startFastSession;
  // A voice call lives inside a Session, so the button opens one (sending
  // anything already typed as the first message) and the Session page starts
  // the call. Matches the flow of a call button beside the composer.
  const [openingVoiceSession, setOpeningVoiceSession] = useState(false);
  const handleVoiceToggle = useCallback(() => {
    if (openingVoiceSession) return;
    setOpeningVoiceSession(true);
    void startFastSessionRef
      .current(
        {
          text: promptText.trim(),
          model: selectedModelOverrideId,
          ...(selectedReasoningEffort !== undefined
            ? { reasoningEffort: selectedReasoningEffort }
            : {}),
          ...(privateModeActive ? { privacy: 'private' as const } : {}),
          voiceCall: true,
        },
        { voice: true },
      )
      .finally(() => setOpeningVoiceSession(false));
  }, [
    openingVoiceSession,
    promptText,
    privateModeActive,
    selectedModelOverrideId,
    selectedReasoningEffort,
  ]);
  const voiceActive = openingVoiceSession;

  const showVoice = voiceEnabled;

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const text = message.text.trim();

      const preparedPrompt = await preparePromptAttachments({
        text,
        attachments: message.files,
      });

      const submission: SubmissionSnapshot = {
        description:
          preparedPrompt.text.length > 0 ? preparedPrompt.text : undefined,
        images: preparedPrompt.images,
        attachmentTexts: preparedPrompt.attachmentTexts,
      };

      if (
        !submission.description &&
        !submission.images?.length &&
        !submission.attachmentTexts?.length
      ) {
        return;
      }
      await startFastSession({
        text: submission.description ?? '',
        images: submission.images,
        attachmentTexts: submission.attachmentTexts,
        model: selectedModelOverrideId,
        ...(privateModeActive ? { privacy: 'private' as const } : {}),
        ...(selectedReasoningEffort !== undefined
          ? { reasoningEffort: selectedReasoningEffort }
          : {}),
      });
    },
    [
      startFastSession,
      selectedModelOverrideId,
      selectedReasoningEffort,
      privateModeActive,
    ],
  );

  return (
    <div
      ref={promptContainerRef}
      className={
        animate ? 'animate-[enter-down_1s_1_100ms_backwards]' : undefined
      }
    >
      <TaskPromptInput
        promptKey={initialPromptText}
        isBusy={isBusy}
        promptText={promptText}
        onPromptTextChange={setPromptText}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        promptSuggestion={promptSuggestion}
        onPromptFocusChange={onPromptFocusChange}
        autoFocus={autoFocus}
        textareaMaxHeight={textareaMaxHeight}
        animateContainer={false}
        submitWithMetaKey={false}
        submitDisabledReason={submitDisabledReason}
        voice={
          showVoice
            ? { active: voiceActive, onToggle: handleVoiceToggle }
            : undefined
        }
        tools={
          <SessionModelSwitcher
            model={selectedModelOverrideId ?? ''}
            onModelChange={(model) =>
              setSelectedModelOverrideId(model || undefined)
            }
            reasoningEffort={selectedReasoningEffort ?? null}
            onReasoningEffortChange={setSelectedReasoningEffort}
            defaultModelId={defaultModelId}
            defaultReasoningEffort={defaultReasoningEffort}
          />
        }
        submitLeadingAction={
          privateSessionsEnabled ? (
            <BasicTooltip content="Private session">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`size-8 rounded-full ${
                  privateSession
                    ? 'bg-accent-foreground/10 text-accent-foreground hover:bg-accent-foreground/20 hover:text-accent-foreground'
                    : 'text-muted-foreground'
                }`}
                aria-label="Private session"
                aria-pressed={privateSession}
                onClick={() => setPrivateSession((selected) => !selected)}
              >
                <HatGlasses />
              </Button>
            </BasicTooltip>
          ) : null
        }
      />
      {fastSessionError ? (
        <div role="alert">
          <RetryableLoadError
            className="mt-3 p-4 md:p-4 [&_[data-slot=empty-icon]]:mb-0"
            message={fastSessionError.message}
            isRetrying={isFastSessionPending}
            onRetry={() => void retryFastSession()}
          />
        </div>
      ) : null}
    </div>
  );
}

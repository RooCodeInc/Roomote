'use client';

import { useState, useCallback, useEffect, useRef, type Ref } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  type ReasoningEffort,
  ALL_REPOSITORIES,
  DEFAULT_LAUNCH_CODING_HARNESS,
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
import { useTaskLaunchConfig } from '@/components/tasks/TaskLaunchConfig';
import { BasicTooltip, Button, HatGlasses } from '@/components/system';

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
  const { defaultComputeProvider } = useTaskLaunchConfig();
  const router = useRouter();
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();

  const searchParams = useSearchParams();
  const promptParam = searchParams.get('prompt') ?? '';
  const modelParam = searchParams.get('model')?.trim() || undefined;
  const environmentIdParam = searchParams.get('environmentId')?.trim() ?? '';

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
    isPending: isFastSessionPending,
    mutation: startFastSessionMutation,
    startFastSession,
  } = useFastSessionLauncher({ onSessionStarted: onTaskStarted });
  const launchTaskModels = useLaunchTaskModels();
  const defaultModelId = environmentIdParam
    ? launchTaskModels.data?.defaultModelId
    : launchTaskModels.data?.defaultFastModelId;
  const defaultReasoningEffort = environmentIdParam
    ? launchTaskModels.data?.defaultReasoningEffort
    : launchTaskModels.data?.defaultFastReasoningEffort;

  // A launch into a chosen environment or repository still belongs to a
  // Session, but the workspace is decided, so the Session delegates the task
  // immediately and the page lands on the task view.
  const launchTask = useCallback(
    async (payload: {
      description?: string;
      images?: string[];
      attachmentTexts?: string[];
    }): Promise<boolean> => {
      if (startFastSessionMutation.isPending) {
        return false;
      }
      try {
        const { taskId } = await startFastSessionMutation.mutateAsync({
          text: payload.description ?? '',
          images: payload.images,
          attachmentTexts: payload.attachmentTexts,
          model: selectedModelOverrideId ?? defaultModelId,
          ...(selectedReasoningEffort !== undefined
            ? { reasoningEffort: selectedReasoningEffort }
            : {}),
          pinnedLaunch: {
            launchId: crypto.randomUUID(),
            repo: ALL_REPOSITORIES,
            environmentId: environmentIdParam,
            harness: DEFAULT_LAUNCH_CODING_HARNESS,
            computeProvider: defaultComputeProvider,
          },
        });
        if (!taskId) {
          toast.error('The task did not start.');
          return false;
        }
        onTaskStarted?.();
        router.push(`/task/${taskId}`);
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Failed to start task',
        );
        return false;
      }
    },
    [
      onTaskStarted,
      router,
      defaultComputeProvider,
      defaultModelId,
      environmentIdParam,
      selectedModelOverrideId,
      selectedReasoningEffort,
      startFastSessionMutation,
    ],
  );

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

  // Voice only applies to Fast sessions; an environment launch is a task.
  const showVoice = voiceEnabled && !environmentIdParam;

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

      if (!environmentIdParam) {
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
        return;
      }

      const didLaunch = await launchTask({
        description: submission.description,
        images: submission.images,
        attachmentTexts: submission.attachmentTexts,
      });

      if (!didLaunch) {
        return;
      }
    },
    [
      environmentIdParam,
      launchTask,
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
          !environmentIdParam && privateSessionsEnabled ? (
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
    </div>
  );
}

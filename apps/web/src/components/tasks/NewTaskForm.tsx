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
import { useStartFastSession } from '@/hooks/task-runs';

import type { PromptInputMessage } from '@/components/ai-elements';
import { SessionModelSwitcher, TaskPromptInput } from '@/components/tasks';
import { useTaskLaunchConfig } from '@/components/tasks/TaskLaunchConfig';
import { BasicTooltip, Button } from '@/components/system';

const DEFAULT_PROMPT_PLACEHOLDER = 'What do you want to do?';

type SubmissionSnapshot = {
  description?: string;
  images?: string[];
  attachmentTexts?: string[];
};

type NewTaskFormProps = {
  animate?: boolean;
  onTaskStarted?: () => void;
  placeholder?: string;
  textareaMaxHeight?: number;
  promptContainerRef?: Ref<HTMLDivElement>;
  allowEmptySession?: boolean;
};

export function NewTaskForm({
  animate = true,
  onTaskStarted,
  placeholder = DEFAULT_PROMPT_PLACEHOLDER,
  textareaMaxHeight,
  promptContainerRef,
  allowEmptySession = false,
}: NewTaskFormProps) {
  const { defaultComputeProvider } = useTaskLaunchConfig();
  const router = useRouter();
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();

  const searchParams = useSearchParams();
  const promptParam = searchParams.get('prompt') ?? '';
  const modelParam = searchParams.get('model')?.trim() || undefined;
  const environmentIdParam = searchParams.get('environmentId')?.trim() ?? '';

  const [promptText, setPromptText] = useState(promptParam);
  const [selectedModelOverrideId, setSelectedModelOverrideId] = useState<
    string | undefined
  >(modelParam);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<
    ReasoningEffort | null | undefined
  >(undefined);
  const emptySessionConversationIdRef = useRef<string | null>(null);

  useEffect(() => setPromptText(promptParam), [promptParam]);
  useEffect(() => setSelectedModelOverrideId(modelParam), [modelParam]);

  const startFastSessionMutation = useStartFastSession();

  const startFastSession = useCallback(
    async (payload: {
      text: string;
      images?: string[];
      attachmentTexts?: string[];
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      conversationId?: string;
      empty?: true;
    }): Promise<void> => {
      // A second submit while the first is in flight would mint a second
      // session and orphan one of them.
      if (startFastSessionMutation.isPending) {
        return;
      }
      try {
        const { sessionId } =
          await startFastSessionMutation.mutateAsync(payload);
        onTaskStarted?.();
        router.push(`/sessions/${sessionId}`);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Failed to start Fast session',
        );
      }
    },
    [onTaskStarted, startFastSessionMutation, router],
  );
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

  const isBusy = startFastSessionMutation.isPending;

  const submitDisabledReason = getTaskLaunchDisabledReason(managedAccess);

  const handleStartEmptySession = useCallback(async () => {
    emptySessionConversationIdRef.current ??= crypto.randomUUID();
    await startFastSession({
      text: '',
      conversationId: emptySessionConversationIdRef.current,
      empty: true,
      model: selectedModelOverrideId,
      ...(selectedReasoningEffort !== undefined
        ? { reasoningEffort: selectedReasoningEffort }
        : {}),
    });
  }, [selectedModelOverrideId, selectedReasoningEffort, startFastSession]);

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
        promptKey={promptParam}
        isBusy={isBusy}
        promptText={promptText}
        onPromptTextChange={setPromptText}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        autoFocus
        textareaMaxHeight={textareaMaxHeight}
        animateContainer={false}
        submitWithMetaKey={false}
        submitDisabledReason={submitDisabledReason}
        tools={
          <>
            <SessionModelSwitcher
              model={selectedModelOverrideId ?? ''}
              onModelChange={setSelectedModelOverrideId}
              reasoningEffort={selectedReasoningEffort ?? null}
              onReasoningEffortChange={setSelectedReasoningEffort}
              defaultModelId={defaultModelId}
              defaultReasoningEffort={defaultReasoningEffort}
            />
            {allowEmptySession ? (
              <BasicTooltip
                content={submitDisabledReason ?? 'Start without a message'}
              >
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isBusy || Boolean(submitDisabledReason)}
                    onClick={handleStartEmptySession}
                  >
                    Start empty session
                  </Button>
                </span>
              </BasicTooltip>
            ) : null}
          </>
        }
      />
    </div>
  );
}

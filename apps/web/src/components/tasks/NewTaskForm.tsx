'use client';

import Link from 'next/link';
import { useState, useCallback, useEffect, useRef, type Ref } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import {
  type ComputeProvider,
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  DEFAULT_LAUNCH_CODING_HARNESS,
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  pickPreferredConfiguredComputeProvider,
  SETUP_COMPUTE_PROVIDER_CATALOG,
} from '@roomote/types';

import { type CreateTaskFormValues, createTaskFormSchema } from '@/types';

import { SETTINGS_PATHS } from '@/lib/settings';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import { getTaskLaunchDisabledReason } from '@/lib/managed-access';

import { useEnvironments } from '@/hooks/environments';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import {
  type WorkspaceSelection,
  useWorkspaceStorage,
} from '@/hooks/useWorkspaceStorage';
import {
  useCreateStandardTaskRun,
  useStartFastSession,
} from '@/hooks/task-runs';

import {
  Alert,
  ArrowRight,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  VectorSquare,
} from '@/components/system';
import type { PromptInputMessage } from '@/components/ai-elements';
import {
  SelectWorkspace,
  ModelSelect,
  TaskPromptInput,
  AUTO_WORKSPACE_VALUE,
} from '@/components/tasks';
import { useTaskLaunchConfig } from '@/components/tasks/TaskLaunchConfig';

const DEFAULT_PROMPT_PLACEHOLDER = 'What do you want to do?';

type SubmissionSnapshot = {
  branch?: string;
  description?: string;
  images?: string[];
  attachmentTexts?: string[];
  blank: boolean;
};

const DEFAULT_FORM_VALUES: CreateTaskFormValues = {
  repository: AUTO_WORKSPACE_VALUE,
  branch: '',
  environmentId: undefined,
  text: '',
  images: [],
  port: undefined,
};

function resolveInitialComputeProvider(
  defaultComputeProvider: ComputeProvider,
  availableComputeProviders: readonly ComputeProvider[],
): ComputeProvider {
  if (availableComputeProviders.includes(defaultComputeProvider)) {
    return defaultComputeProvider;
  }

  return (
    pickPreferredConfiguredComputeProvider(availableComputeProviders) ??
    defaultComputeProvider
  );
}

type NewTaskFormProps = {
  defaultComputeProvider?: ComputeProvider;
  availableComputeProviders?: readonly ComputeProvider[];
  onTaskStarted?: () => void;
  placeholder?: string;
  textareaMaxHeight?: number;
  promptContainerRef?: Ref<HTMLDivElement>;
};

export function NewTaskForm({
  defaultComputeProvider: defaultComputeProviderOverride,
  availableComputeProviders,
  onTaskStarted,
  placeholder = DEFAULT_PROMPT_PLACEHOLDER,
  textareaMaxHeight,
  promptContainerRef,
}: NewTaskFormProps) {
  const taskLaunchConfig = useTaskLaunchConfig();
  const defaultComputeProvider =
    defaultComputeProviderOverride ?? taskLaunchConfig.defaultComputeProvider;
  const resolvedAvailableComputeProviders =
    availableComputeProviders ?? taskLaunchConfig.availableComputeProviders;
  const router = useRouter();
  const environments = useEnvironments();
  const {
    cloudEnabled,
    isAdmin,
    managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  } = useAuthorizedUser();

  const canSelectBranch = false;

  // Keep option order identical to the setup catalog so the first fallback
  // matches the first visible Sandbox provider row.
  const catalogComputeProviders = SETUP_COMPUTE_PROVIDER_CATALOG.map(
    (descriptor) => descriptor.provider,
  );
  const computeProviderOptions =
    resolvedAvailableComputeProviders === undefined
      ? catalogComputeProviders
      : resolvedAvailableComputeProviders.length > 0
        ? catalogComputeProviders.filter((provider) =>
            resolvedAvailableComputeProviders.includes(provider),
          )
        : [defaultComputeProvider];
  const computeProviderDescriptors = SETUP_COMPUTE_PROVIDER_CATALOG.filter(
    (descriptor) => computeProviderOptions.includes(descriptor.provider),
  );
  const initialComputeProvider = resolveInitialComputeProvider(
    defaultComputeProvider,
    computeProviderOptions,
  );

  const searchParams = useSearchParams();
  const promptParam = searchParams.get('prompt') ?? '';
  const modelParam = searchParams.get('model')?.trim() || undefined;
  const environmentIdParam = searchParams.get('environmentId')?.trim() ?? '';

  const [promptText, setPromptText] = useState(promptParam);
  const [selectedComputeProvider, setSelectedComputeProvider] =
    useState<ComputeProvider>(initialComputeProvider);
  const [selectedModelOverrideId, setSelectedModelOverrideId] = useState<
    string | undefined
  >(modelParam);

  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPromptText(promptParam), [promptParam]);
  useEffect(() => setSelectedModelOverrideId(modelParam), [modelParam]);

  const form = useForm<CreateTaskFormValues>({
    resolver: zodResolver(createTaskFormSchema),
    defaultValues: DEFAULT_FORM_VALUES,
  });

  const { workspace, setWorkspace } = useWorkspaceStorage();
  const hasRestoredWorkspace = useRef(false);
  const shouldRestoreDefaultWorkspace = useRef(false);

  const handleInvalidWorkspaceReset = useCallback(() => {
    shouldRestoreDefaultWorkspace.current = true;
  }, []);

  useEffect(() => {
    const restoredWorkspace = workspace.workspace as
      | WorkspaceSelection['workspace']
      | undefined;

    if (hasRestoredWorkspace.current) {
      if (
        !shouldRestoreDefaultWorkspace.current ||
        restoredWorkspace?.type !== 'auto' ||
        form.getValues('repository') !== AUTO_WORKSPACE_VALUE
      ) {
        return;
      }

      hasRestoredWorkspace.current = false;
      shouldRestoreDefaultWorkspace.current = false;
    }

    if (environmentIdParam) {
      form.setValue('repository', environmentIdParam);
      form.setValue('environmentId', environmentIdParam);
      form.setValue('branch', '');

      setWorkspace({
        workspace: { type: 'environment', id: environmentIdParam },
      });

      hasRestoredWorkspace.current = true;
      return;
    }

    if (form.getValues('repository') !== AUTO_WORKSPACE_VALUE) {
      hasRestoredWorkspace.current = true;
      return;
    }

    // Fast mode is always the default workspace for new prompts.
    form.setValue('repository', FAST_EXECUTION);
    form.setValue('environmentId', undefined);
    form.setValue('branch', '');
    hasRestoredWorkspace.current = true;
  }, [environmentIdParam, form, setWorkspace, workspace]);

  const wiggleWorkspace = useCallback(() => {
    const el = workspaceRef.current;

    if (!el) {
      return;
    }

    el.classList.remove('animate-wiggle');
    void el.offsetWidth;
    el.classList.add('animate-wiggle');
  }, []);

  const navigateToTaskRun = (result: {
    success: boolean;
    taskId?: string;
    sessionId?: string;
    error?: string;
  }) => {
    if (result.success && 'taskId' in result) {
      onTaskStarted?.();
      router.push(
        result.sessionId
          ? `/sessions/${result.sessionId}`
          : `/task/${result.taskId}`,
      );
    } else if ('error' in result) {
      toast.error(result.error);
    }
  };

  const mutationOptions = {
    onSuccess: navigateToTaskRun,
    onError: (error: Error) => toast.error(error.message),
  };

  const createStandardTaskRun = useCreateStandardTaskRun(mutationOptions);
  const startFastSessionMutation = useStartFastSession();

  const startFastSession = useCallback(
    async (payload: {
      text: string;
      images?: string[];
      attachmentTexts?: string[];
      model?: string;
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
  const selectedModelId =
    selectedModelOverrideId ?? launchTaskModels.data?.defaultModelId;

  const launchTask = useCallback(
    async (payload: {
      repo: string;
      branch?: string;
      environmentId?: string;
      description?: string;
      images?: string[];
      modelId?: string;
      blank: boolean;
    }): Promise<boolean> => {
      try {
        const result = await createStandardTaskRun.mutateAsync({
          harness: DEFAULT_LAUNCH_CODING_HARNESS,
          model: payload.modelId ?? selectedModelId,
          computeProvider: selectedComputeProvider,
          payload,
        });

        return result.success;
      } catch {
        return false;
      }
    },
    [createStandardTaskRun, selectedComputeProvider, selectedModelId],
  );

  const isBusy =
    createStandardTaskRun.isPending || startFastSessionMutation.isPending;

  const hasAnyEnvironments = (environments.data?.length ?? 0) > 0;
  const showNoEnvironmentsWarning =
    isAdmin && !environments.isPending && !hasAnyEnvironments;
  const submitDisabledReason = getTaskLaunchDisabledReason(managedAccess);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const { repository, branch, environmentId } = form.getValues();
      const isAutoWorkspace = repository === AUTO_WORKSPACE_VALUE;

      if (!isAutoWorkspace && !repository) {
        wiggleWorkspace();
        return;
      }

      const text = message.text.trim();

      const preparedPrompt = await preparePromptAttachments({
        text,
        attachments: message.files,
      });

      const submission: SubmissionSnapshot = {
        branch: canSelectBranch ? branch : undefined,
        description:
          preparedPrompt.text.length > 0 ? preparedPrompt.text : undefined,
        images: preparedPrompt.images,
        attachmentTexts: preparedPrompt.attachmentTexts,
        blank: preparedPrompt.text.length === 0,
      };

      if (repository === FAST_EXECUTION) {
        if (!submission.description && !submission.images?.length) {
          return;
        }
        await startFastSession({
          text: submission.description ?? '',
          images: submission.images,
          attachmentTexts: submission.attachmentTexts,
          model: selectedModelId,
        });
        return;
      }

      // Auto is no longer offered in the picker, but stored workspace
      // preferences may still restore it; treat it as Fast.
      if (isAutoWorkspace) {
        if (!submission.description && !submission.images?.length) return;
        await startFastSession({
          text: submission.description ?? '',
          images: submission.images,
          attachmentTexts: submission.attachmentTexts,
          model: selectedModelId,
        });
        return;
      }

      const didLaunch = await launchTask({
        repo: environmentId ? ALL_REPOSITORIES : repository,
        branch: environmentId ? undefined : submission.branch,
        environmentId,
        description: submission.description,
        images: submission.images,
        blank: submission.blank,
      });

      if (!didLaunch) {
        return;
      }

      setWorkspace({
        workspace: environmentId
          ? { type: 'environment', id: environmentId }
          : { type: 'repository', value: repository },
      });
    },
    [
      form,
      launchTask,
      setWorkspace,
      canSelectBranch,
      wiggleWorkspace,
      startFastSession,
      selectedModelId,
    ],
  );

  return (
    <FormProvider {...form}>
      <div className="flex flex-wrap items-center gap-2 animate-[enter-down_1s_1_100ms_backwards]">
        <div ref={workspaceRef}>
          <SelectWorkspace
            allowFast
            autoSelectDefaultWorkspace={false}
            onInvalidWorkspaceReset={handleInvalidWorkspaceReset}
            allowBranchSelection={canSelectBranch}
          />
        </div>

        <ModelSelect
          value={selectedModelId}
          onValueChange={setSelectedModelOverrideId}
        />

        {!cloudEnabled && computeProviderDescriptors.length > 1 && (
          <Select
            value={selectedComputeProvider}
            onValueChange={(value) =>
              setSelectedComputeProvider(value as ComputeProvider)
            }
          >
            <SelectTrigger size="sm" aria-label="Sandbox provider">
              <SelectValue placeholder="Backend" />
            </SelectTrigger>
            <SelectContent>
              {computeProviderDescriptors.map((descriptor) => (
                <SelectItem
                  key={descriptor.provider}
                  value={descriptor.provider}
                >
                  {descriptor.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div
        ref={promptContainerRef}
        className="animate-[enter-down_1s_1_200ms_backwards]"
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
          submitDisabledReason={submitDisabledReason}
        />
      </div>

      {showNoEnvironmentsWarning && (
        <Alert
          variant="light"
          className="mt-2 animate-[enter-down_1s_1_300ms_backwards]"
        >
          <VectorSquare />
          <p>
            <span>You haven&apos;t created any environments yet. </span>
            <span className="block md:inline">
              Roomote can work directly on your repos, but it can&apos;t verify
              its work.{' '}
            </span>
            <Link
              href={SETTINGS_PATHS.newEnvironment}
              className="text-primary font-semibold underline hover:no-underline block md:inline"
            >
              Create your first <ArrowRight className="inline size-4" />
            </Link>
          </p>
        </Alert>
      )}
    </FormProvider>
  );
}

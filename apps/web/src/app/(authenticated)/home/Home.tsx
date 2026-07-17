'use client';

import Link from 'next/link';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import {
  type ComputeProvider,
  ALL_REPOSITORIES,
  DEFAULT_LAUNCH_CODING_HARNESS,
  SETUP_COMPUTE_PROVIDER_CATALOG,
} from '@roomote/types';
import type { RoutingDecision } from '@roomote/cloud-agents/server';

import { type CreateTaskFormValues, createTaskFormSchema } from '@/types';

import { SETTINGS_PATHS } from '@/lib/settings';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import { cn } from '@/lib/utils';

import { useEnvironments } from '@/hooks/environments';
import { useGitHubInstallations } from '@/hooks/github';
import { useShowDebugUI } from '@/hooks/useShowDebugUI';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import {
  type WorkspaceSelection,
  useWorkspaceStorage,
} from '@/hooks/useWorkspaceStorage';
import { useCreateStandardTaskRun, useRouteHomeTask } from '@/hooks/task-runs';

import {
  Alert,
  ArrowRight,
  Loader2,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TriangleAlert,
} from '@/components/system';
import type { PromptInputMessage } from '@/components/ai-elements';
import {
  SelectWorkspace,
  ModelSelect,
  TaskPromptInput,
  AUTO_WORKSPACE_VALUE,
} from '@/components/tasks';

import { OnboardingCard } from './OnboardingCard';
import { BottomSheetTabs } from './BottomSheetTabs';
import {
  HOME_PROMPT_PLACEHOLDERS,
  normalizeHomePromptPlaceholderIndex,
} from './promptPlaceholders';

const FALLBACK_PROMPT_PLACEHOLDER = 'What do you want to do?';

type RoutingFlowState = 'idle' | 'routing_pending' | 'launching';

type SubmissionSnapshot = {
  branch?: string;
  description?: string;
  images?: string[];
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

  return availableComputeProviders[0] ?? defaultComputeProvider;
}

type HomeProps = {
  initialPlaceholderIndex: number;
  defaultComputeProvider?: ComputeProvider;
  availableComputeProviders?: readonly ComputeProvider[];
};

export function Home({
  initialPlaceholderIndex,
  defaultComputeProvider = 'docker',
  availableComputeProviders,
}: HomeProps) {
  const router = useRouter();
  const githubInstallations = useGitHubInstallations();
  const environments = useEnvironments();
  const { cloudEnabled } = useAuthorizedUser();

  const { isDebugUIVisible } = useShowDebugUI();
  const canSelectBranch = isDebugUIVisible;

  // Keep option order identical to the setup catalog so the first fallback
  // matches the first visible Sandbox provider row.
  const catalogComputeProviders = SETUP_COMPUTE_PROVIDER_CATALOG.map(
    (descriptor) => descriptor.provider,
  );
  const computeProviderOptions =
    availableComputeProviders === undefined
      ? catalogComputeProviders
      : availableComputeProviders.length > 0
        ? catalogComputeProviders.filter((provider) =>
            availableComputeProviders.includes(provider),
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
  const environmentIdParam = searchParams.get('environmentId')?.trim() ?? '';

  const [promptText, setPromptText] = useState(promptParam);
  const [isExiting, setIsExiting] = useState(false);
  const [routingState, setRoutingState] = useState<RoutingFlowState>('idle');
  const [selectedComputeProvider, setSelectedComputeProvider] =
    useState<ComputeProvider>(initialComputeProvider);
  const [selectedModelOverrideId, setSelectedModelOverrideId] =
    useState<string>();
  const [isBottomSheetExpanded, setIsBottomSheetExpanded] = useState(false);
  const [isShortViewport, setIsShortViewport] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(() =>
    normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
  );

  const activePromptPlaceholder =
    HOME_PROMPT_PLACEHOLDERS[placeholderIndex] ?? FALLBACK_PROMPT_PLACEHOLDER;

  const workspaceRef = useRef<HTMLDivElement>(null);
  const contentColumnRef = useRef<HTMLDivElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);

  const [textareaMaxHeight, setTextareaMaxHeight] = useState<
    number | undefined
  >(undefined);

  const routingRequestIdRef = useRef(0);

  useEffect(() => setPromptText(promptParam), [promptParam]);

  useEffect(() => {
    setPlaceholderIndex(
      normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
    );
  }, [initialPlaceholderIndex]);

  useEffect(() => {
    if (HOME_PROMPT_PLACEHOLDERS.length <= 1) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setPlaceholderIndex(
        (currentIndex) => (currentIndex + 1) % HOME_PROMPT_PLACEHOLDERS.length,
      );
    }, 5_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  // Dynamically compute the max textarea height so it can grow to fill the
  // available space without pushing the bottom-sheet tabs off screen.
  useEffect(() => {
    const column = contentColumnRef.current;
    const card = promptCardRef.current;

    if (!column || !card) {
      return;
    }

    const compute = () => {
      const columnHeight = column.clientHeight;

      // Sum the heights of every sibling element in the column except the
      // prompt card itself.
      let siblingsHeight = 0;

      for (const child of column.children) {
        if (child === card) {
          continue;
        }

        siblingsHeight += (child as HTMLElement).offsetHeight;
      }

      // Account for column gap (gap-4 = 16px, md:gap-3 = 12px).
      const style = getComputedStyle(column);
      const gap = parseFloat(style.rowGap || style.gap || '0');
      const gapCount = column.children.length - 1;
      const totalGap = gap * Math.max(0, gapCount);

      // The prompt card has its own chrome around the textarea: the footer
      // bar, padding, and border. Measure it by subtracting the textarea's
      // current height from the card's height.
      const textarea = card.querySelector('textarea');
      const promptChrome = textarea
        ? card.offsetHeight - textarea.offsetHeight
        : 60;

      const available = columnHeight - siblingsHeight - totalGap - promptChrome;

      // Never go below a sensible minimum (min-h-30 = 120px).
      setTextareaMaxHeight(Math.max(120, Math.floor(available)));
    };

    compute();

    const observer = new ResizeObserver(compute);
    observer.observe(column);
    window.addEventListener('resize', compute);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);

  const form = useForm<CreateTaskFormValues>({
    resolver: zodResolver(createTaskFormSchema),
    defaultValues: DEFAULT_FORM_VALUES,
  });
  const watchedRepository = form.watch('repository');

  const { workspace, setWorkspace } = useWorkspaceStorage();
  const hasRestoredWorkspace = useRef(false);

  const clearRoutingState = useCallback(() => {
    setRoutingState('idle');
  }, []);

  const cancelRoutingInFlight = useCallback(() => {
    routingRequestIdRef.current += 1;
    clearRoutingState();
  }, [clearRoutingState]);

  const resetToAutoWorkspace = useCallback(() => {
    setWorkspace({
      workspace: { type: 'auto' },
    });

    form.setValue('repository', AUTO_WORKSPACE_VALUE);
    form.setValue('environmentId', undefined);
    form.setValue('branch', '');
  }, [form, setWorkspace]);

  useEffect(() => {
    if (hasRestoredWorkspace.current) {
      return;
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

    const restoredWorkspace = workspace.workspace as
      | WorkspaceSelection['workspace']
      | undefined;

    if (restoredWorkspace?.type === 'repository') {
      form.setValue('repository', restoredWorkspace.value);
      form.setValue('environmentId', undefined);
      hasRestoredWorkspace.current = true;
      return;
    }

    if (restoredWorkspace?.type === 'environment') {
      form.setValue('repository', restoredWorkspace.id);
      form.setValue('environmentId', restoredWorkspace.id);
      hasRestoredWorkspace.current = true;
      return;
    }

    // Auto (or unset) stored preference: wait for environments so we can
    // default the sole environment instead of writing Auto over the selector.
    if (environments.isPending || !environments.isSuccess) {
      return;
    }

    const soleEnvironment =
      environments.data?.length === 1 ? environments.data[0] : undefined;

    if (soleEnvironment) {
      form.setValue('repository', soleEnvironment.id);
      form.setValue('environmentId', soleEnvironment.id);
      form.setValue('branch', '');
      setWorkspace({
        workspace: { type: 'environment', id: soleEnvironment.id },
      });
    } else {
      form.setValue('repository', AUTO_WORKSPACE_VALUE);
      form.setValue('environmentId', undefined);
      form.setValue('branch', '');
    }

    hasRestoredWorkspace.current = true;
  }, [
    environmentIdParam,
    environments.data,
    environments.isPending,
    environments.isSuccess,
    form,
    setWorkspace,
    workspace,
  ]);

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
    error?: string;
  }) => {
    if (result.success && 'taskId' in result) {
      setIsExiting(true);
      router.push(`/task/${result.taskId}`);
    } else if ('error' in result) {
      toast.error(result.error);
    }
  };

  const mutationOptions = {
    onSuccess: navigateToTaskRun,
    onError: (error: Error) => toast.error(error.message),
  };

  const createStandardTaskRun = useCreateStandardTaskRun(mutationOptions);
  const routeHomeTask = useRouteHomeTask();
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

  useEffect(() => {
    if (routingState !== 'routing_pending') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      cancelRoutingInFlight();
      resetToAutoWorkspace();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cancelRoutingInFlight, resetToAutoWorkspace, routingState]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-height: 80rem)');
    const syncViewportHeight = () => {
      setIsShortViewport(mediaQuery.matches);
    };

    syncViewportHeight();
    mediaQuery.addEventListener('change', syncViewportHeight);

    return () => {
      mediaQuery.removeEventListener('change', syncViewportHeight);
    };
  }, []);

  const isBusy =
    createStandardTaskRun.isPending ||
    routingState === 'routing_pending' ||
    routingState === 'launching';

  const showRoutingSpinner = routingState === 'routing_pending';
  const shouldDimMainForm = isBottomSheetExpanded && isShortViewport;
  const hasAnyEnvironments = (environments.data?.length ?? 0) > 0;
  const showNoEnvironmentsWarning =
    !environments.isPending && !hasAnyEnvironments;
  const submitDisabledReason =
    !hasAnyEnvironments && watchedRepository === AUTO_WORKSPACE_VALUE
      ? 'Auto routing needs an environment. Create one, or select All Repositories to work without one.'
      : undefined;

  const handleAutoSubmit = useCallback(
    async (submission: SubmissionSnapshot) => {
      cancelRoutingInFlight();
      setRoutingState('routing_pending');
      const routingRequestId = routingRequestIdRef.current + 1;
      routingRequestIdRef.current = routingRequestId;

      let routedResult: RoutingDecision;

      try {
        routedResult = await routeHomeTask.mutateAsync({
          description: submission.description ?? '',
          ...(submission.images?.length ? { images: submission.images } : {}),
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Could not auto-route this task.',
        );
        clearRoutingState();
        return;
      }

      if (routingRequestId !== routingRequestIdRef.current) {
        return;
      }

      if (routedResult.status === 'platform_answer') {
        toast(routedResult.result.answer);
        clearRoutingState();
        return;
      }

      if (routedResult.status === 'fallback') {
        toast.error("Couldn't auto-route this task.");
        clearRoutingState();
        return;
      }

      if (routedResult.result.workspace.type === 'environment') {
        if (!routedResult.result.workspace.id.trim()) {
          toast.error('Could not determine a routed environment.');
          clearRoutingState();
          return;
        }
      } else {
        toast.error('Auto routing requires an environment-backed workspace.');
        clearRoutingState();
        return;
      }

      setRoutingState('launching');
      const routedModelId =
        routedResult.result.model?.source === 'preference'
          ? routedResult.result.model.id
          : undefined;

      const didLaunch = await launchTask({
        repo: ALL_REPOSITORIES,
        branch: submission.branch,
        environmentId:
          routedResult.result.workspace.type === 'environment'
            ? routedResult.result.workspace.id
            : undefined,
        description: submission.description,
        images: submission.images,
        modelId: routedModelId,
        blank: submission.blank,
      });

      if (didLaunch) {
        resetToAutoWorkspace();
      }

      clearRoutingState();
    },
    [
      cancelRoutingInFlight,
      clearRoutingState,
      launchTask,
      resetToAutoWorkspace,
      routeHomeTask,
    ],
  );

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
        blank: preparedPrompt.text.length === 0,
      };

      if (isAutoWorkspace) {
        await handleAutoSubmit(submission);
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
      handleAutoSubmit,
      launchTask,
      setWorkspace,
      canSelectBranch,
      wiggleWorkspace,
    ],
  );

  if (githubInstallations.isPending) {
    return null;
  }

  return (
    <FormProvider {...form}>
      <div className="flex flex-1 md:items-center justify-center h-[calc(var(--effective-viewport-height)-4rem)] md:h-[calc(var(--effective-viewport-height)-1rem)]">
        <div
          className={cn(
            'flex w-full max-w-3xl flex-col px-4 justify-center h-full',
            isExiting && 'animate-[exit-right_500ms_1_forwards]',
          )}
        >
          <div
            ref={contentColumnRef}
            className={cn(
              'flex flex-col gap-4 md:gap-3 grow flex-1 min-h-0 overflow-y-auto md:overflow-visible md:h-full justify-start md:justify-center transition-all duration-500',
              shouldDimMainForm && 'scale-90 blur-[3px] opacity-70',
            )}
          >
            <h1 className="text-2xl tracking-tight font-bold animate-[enter-down_1s_1] pt-10 md:pt-0">
              {promptParam ? (
                <>Let&apos;s do this</>
              ) : (
                <>Let&apos;s get started</>
              )}
            </h1>

            <div
              data-testid="home-top-controls"
              className="flex flex-wrap items-center gap-2 animate-[enter-down_1s_1_100ms_backwards]"
            >
              <div ref={workspaceRef}>
                <SelectWorkspace
                  allowAuto
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
                  <SelectTrigger
                    size="sm"
                    className="w-36"
                    aria-label="Sandbox provider"
                  >
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

              {showRoutingSpinner && (
                <div
                  aria-live="polite"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Routing...</span>
                </div>
              )}
            </div>

            <div
              ref={promptCardRef}
              className="animate-[enter-down_1s_1_200ms_backwards]"
            >
              <TaskPromptInput
                promptKey={promptParam}
                isBusy={isBusy}
                promptText={promptText}
                onPromptTextChange={setPromptText}
                onSubmit={handleSubmit}
                placeholder={activePromptPlaceholder}
                autoFocus
                textareaMaxHeight={textareaMaxHeight}
                animateContainer={false}
                submitDisabledReason={submitDisabledReason}
              />
              {showNoEnvironmentsWarning && (
                <Alert variant="warning" className="mt-2">
                  <TriangleAlert />
                  <p>
                    You haven&apos;t created any environments yet. Roomote can
                    work directly on your repos, but it can&apos;t verify its
                    work.{' '}
                    <Link
                      href={SETTINGS_PATHS.newEnvironment}
                      className="text-primary font-semibold underline hover:no-underline"
                    >
                      Create an environment now{' '}
                      <ArrowRight className="inline size-4" />
                    </Link>
                  </p>
                </Alert>
              )}
            </div>

            <div className="flex flex-col md:flex-row flex-wrap md:items-center gap-2 animate-[fade-in_1s_1_750ms_backwards]">
              <OnboardingCard />
            </div>
          </div>
          <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
            <BottomSheetTabs onExpandedChange={setIsBottomSheetExpanded} />
          </div>
        </div>
      </div>
    </FormProvider>
  );
}

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
  FAST_EXECUTION,
  DEFAULT_LAUNCH_CODING_HARNESS,
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  pickPreferredConfiguredComputeProvider,
  SETUP_COMPUTE_PROVIDER_CATALOG,
} from '@roomote/types';

import { type CreateTaskFormValues, createTaskFormSchema } from '@/types';

import { SETTINGS_PATHS } from '@/lib/settings';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import { cn } from '@/lib/utils';
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
  Button,
  Calendar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Mail,
  MessageCirclePlus,
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

import { OnboardingCard } from './OnboardingCard';
import { BottomSheetTabs } from './BottomSheetTabs';
import Image from 'next/image';
import { DiscordLogoIcon } from '@radix-ui/react-icons';
import {
  HOME_PROMPT_PLACEHOLDERS,
  normalizeHomePromptPlaceholderIndex,
} from './promptPlaceholders';

const FALLBACK_PROMPT_PLACEHOLDER = 'What do you want to do?';
const FEEDBACK_DISMISSED_STORAGE_KEY = 'roomote-home-feedback-dismissed';
const FEEDBACK_CALENDLY_URL =
  'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback';
const FEEDBACK_EMAIL_URL =
  'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far';
const FEEDBACK_DISCORD_URL = 'https://discord.gg/roomote';

function isFeedbackPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(FEEDBACK_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistFeedbackPromptDismissal(): void {
  try {
    window.localStorage.setItem(FEEDBACK_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Ignore storage failures; the prompt can still be dismissed for this session.
  }
}

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

  return (
    pickPreferredConfiguredComputeProvider(availableComputeProviders) ??
    defaultComputeProvider
  );
}

type HomeProps = {
  initialPlaceholderIndex: number;
  defaultComputeProvider?: ComputeProvider;
  availableComputeProviders?: readonly ComputeProvider[];
};

type NewTaskFormProps = HomeProps & {
  presentation?: 'home' | 'dialog';
  onTaskStarted?: () => void;
};

export function Home(props: HomeProps) {
  return <NewTaskForm {...props} />;
}

export function NewTaskForm({
  initialPlaceholderIndex,
  defaultComputeProvider: defaultComputeProviderOverride,
  availableComputeProviders,
  presentation = 'home',
  onTaskStarted,
}: NewTaskFormProps) {
  const taskLaunchConfig = useTaskLaunchConfig();
  const defaultComputeProvider =
    defaultComputeProviderOverride ?? taskLaunchConfig.defaultComputeProvider;
  const resolvedAvailableComputeProviders =
    availableComputeProviders ?? taskLaunchConfig.availableComputeProviders;
  const isHomePresentation = presentation === 'home';
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
  const [isExiting, setIsExiting] = useState(false);
  const [selectedComputeProvider, setSelectedComputeProvider] =
    useState<ComputeProvider>(initialComputeProvider);
  const [selectedModelOverrideId, setSelectedModelOverrideId] = useState<
    string | undefined
  >(modelParam);
  const [isBottomSheetExpanded, setIsBottomSheetExpanded] = useState(false);
  const [isFeedbackPromptVisible, setIsFeedbackPromptVisible] = useState(false);
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
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

  useEffect(() => setPromptText(promptParam), [promptParam]);
  useEffect(() => setSelectedModelOverrideId(modelParam), [modelParam]);

  useEffect(() => {
    if (!isHomePresentation) {
      return;
    }

    setIsFeedbackPromptVisible(!isFeedbackPromptDismissed());
  }, [isHomePresentation]);

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
    if (!isHomePresentation) {
      return;
    }

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
  }, [isHomePresentation]);

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
      setIsExiting(true);
      router.push(
        result.sessionId
          ? `/sessions/${result.sessionId}?task=${result.taskId}`
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
        setIsExiting(true);
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
    createStandardTaskRun.isPending || startFastSessionMutation.isPending;

  const shouldDimMainForm = isBottomSheetExpanded && isShortViewport;
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
        blank: preparedPrompt.text.length === 0,
      };

      if (repository === FAST_EXECUTION) {
        if (!submission.description && !submission.images?.length) {
          return;
        }
        await startFastSession({
          text: submission.description ?? '',
          images: submission.images,
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
      <div
        className={cn(
          isHomePresentation &&
            'flex flex-1 md:items-center justify-center h-[calc(var(--effective-viewport-height)-4rem)] md:h-[calc(var(--effective-viewport-height)-1rem)]',
        )}
      >
        <div
          className={cn(
            'flex w-full max-w-3xl flex-col justify-center',
            isHomePresentation && 'px-4 h-full',
            isExiting && 'animate-[exit-right_500ms_1_forwards]',
          )}
        >
          <div
            ref={contentColumnRef}
            className={cn(
              'flex flex-col gap-4 md:gap-3 justify-start',
              isHomePresentation &&
                'grow flex-1 min-h-0 overflow-y-auto md:overflow-visible md:h-full md:justify-center transition-all duration-500',
              shouldDimMainForm && 'scale-90 blur-[3px] opacity-70',
            )}
          >
            {isHomePresentation && (
              <h1 className="text-2xl tracking-tight font-bold animate-[enter-down_1s_1] pt-10 md:pt-0">
                New Session
              </h1>
            )}

            <div
              data-testid="home-top-controls"
              className="flex flex-wrap items-center gap-2 animate-[enter-down_1s_1_100ms_backwards]"
            >
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
                    Roomote can work directly on your repos, but it can&apos;t
                    verify its work.{' '}
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

            {isHomePresentation && (
              <div className="flex flex-col md:flex-row flex-wrap md:items-center gap-2 animate-[fade-in_1s_1_750ms_backwards]">
                {!showNoEnvironmentsWarning && <OnboardingCard />}
                {!showNoEnvironmentsWarning && isFeedbackPromptVisible ? (
                  <button
                    type="button"
                    onClick={() => setIsFeedbackDialogOpen(true)}
                    className="inline-flex cursor-pointer items-center font-semibold whitespace-nowrap text-sm text-muted-foreground/80 hover:text-accent-foreground md:ml-auto"
                  >
                    <MessageCirclePlus className="mr-1.5 size-4 shrink-0" />
                    Feedback, please!
                  </button>
                ) : null}
              </div>
            )}
          </div>
          {isHomePresentation && (
            <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
              <BottomSheetTabs onExpandedChange={setIsBottomSheetExpanded} />
            </div>
          )}
        </div>
      </div>

      {isHomePresentation && (
        <Dialog
          open={isFeedbackDialogOpen}
          onOpenChange={setIsFeedbackDialogOpen}
        >
          <DialogContent size="xl">
            <DialogHeader>
              <DialogTitle>What do you think of Roomote so far?</DialogTitle>
              <DialogDescription>
                We&apos;d love to hear about your experience. Anything helps.
              </DialogDescription>
            </DialogHeader>

            <div className="relative my-4 flex flex-col gap-2">
              <Button
                asChild
                variant="default"
                className="md:max-w-xs md:justify-start"
              >
                <a
                  href={FEEDBACK_CALENDLY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Calendar className="size-3.5" />
                  Schedule time with the team
                </a>
              </Button>
              <Button
                asChild
                variant="default"
                className="md:max-w-xs md:justify-start"
              >
                <a href={FEEDBACK_EMAIL_URL}>
                  <Mail className="size-3.5" />
                  Email us
                </a>
              </Button>
              <Button
                asChild
                variant="default"
                className="md:max-w-xs md:justify-start"
              >
                <a href={FEEDBACK_DISCORD_URL} target="_blank" rel="noreferrer">
                  <DiscordLogoIcon className="size-3.5" />
                  Join the discord
                </a>
              </Button>
              <Image
                src="/elements/feedback.png"
                alt=""
                width={150}
                height={150}
                className="absolute -top-9 right-0 hidden size-44 md:block"
              />
            </div>

            <DialogFooter className="md:justify-between">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  persistFeedbackPromptDismissal();
                  setIsFeedbackPromptVisible(false);
                }}
                aria-label="Dismiss feedback prompt"
              >
                Don&apos;t show this again
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </FormProvider>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PRODUCT_NAME,
  type SetupNewComputeProvisioningState,
} from '@roomote/types';
import type { SourceControlProvider } from '@roomote/types';
import {
  Button,
  Alert,
  AlertCircle,
  AlertDescription,
  Loader2,
  ArrowRight,
  Checkbox,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { useEnvironments } from '@/hooks/environments/useEnvironments';
import { useUser } from '@/hooks/useUser';
import {
  SETUP_STARTER_TASKS,
  getSetupStarterTask,
  type SetupStarterTaskId,
} from '@/lib/setup-starter-tasks';
import { buildInvokeMethods } from '../invokeMethods';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const INVOKE_STEP = getSetupStepDefinition('invoke');

const STARTER_TASKS_TITLE = "You're set up. Let's get Roomote working.";

type CommunicationProviderId = 'slack' | 'microsoft' | 'telegram' | 'discord';

type StepInvokeProps = {
  onTryItOut?: () => void;
  onboardingTaskId?: string | null;
  linkSuggestedTasks?: boolean;
  communicationProviders?: readonly CommunicationProviderId[];
  sourceControlProviders?: readonly SourceControlProvider[];
  includeLinear?: boolean;
  computeProvisioning?: SetupNewComputeProvisioningState | null;
  onRetryComputeProvisioning?: () => void;
};

export function StepInvoke(props: StepInvokeProps = {}) {
  // Legacy sessions that already run a background environment-setup task keep
  // the previous invocation-guide behavior (and its immediate task redirect)
  // instead of the starter-task catalog.
  return props.onboardingTaskId ? (
    <OnboardingTaskStepContent {...props} />
  ) : (
    <StarterTasksStepContent {...props} />
  );
}

/**
 * Completes setup through the pre-starter-tasks mutation and preserves its
 * navigation semantics: optimistic route-guard cache updates, immediate
 * redirect to a known onboarding task, and Home routing with the newest
 * environment preselected otherwise.
 */
function useCompleteSetupMutation({
  onboardingTaskId = null,
  linkSuggestedTasks = false,
}: {
  onboardingTaskId?: string | null;
  linkSuggestedTasks?: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const environments = useEnvironments({ enabled: !onboardingTaskId });

  return useMutation(
    trpc.setup.complete.mutationOptions({
      onSuccess: async () => {
        // Optimistically mark setup as completed in the cache so the
        // authenticated layout doesn't redirect back to /setup.
        queryClient.setQueryData(trpc.setup.status.queryKey(), (old) =>
          old ? { ...old, setupCompletedAt: new Date() } : old,
        );
        queryClient.setQueryData(trpc.onboarding.status.queryKey(), (old) =>
          old ? { ...old, onboardingCompletedAt: new Date() } : old,
        );

        // When an onboarding task is already known (background env setup),
        // leave for that task before any await. Yielding first lets /setup's
        // completed-setup guard race and flash Home before the task page.
        if (onboardingTaskId) {
          router.replace(`/task/${onboardingTaskId}`);
        }

        // setup.complete also marks onboarding as completed server-side.
        // Invalidate both route guards so the next page load cannot reuse
        // stale cached status and bounce the user back into onboarding.
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.setup.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.onboarding.status.queryKey(),
          }),
        ]);

        // Remove cached query data that the Home page checks to decide
        // whether to redirect to /tasks. We use removeQueries (not
        // invalidateQueries) because invalidate only refetches *active*
        // queries — there are no subscribers on the onboarding page, so
        // invalidate would just mark stale data without clearing it.
        // Removing forces a fresh fetch when Home mounts, starting from
        // isPending: true so the redirect guard works correctly.
        queryClient.removeQueries({
          queryKey: trpc.github.installations.queryKey(),
        });

        if (onboardingTaskId) {
          return;
        }

        const refreshedSetupNewStatus = await queryClient.fetchQuery(
          trpc.setupNew.status.queryOptions(undefined, { staleTime: 0 }),
        );
        const targetTaskId = refreshedSetupNewStatus.onboardingFailed
          ? null
          : (refreshedSetupNewStatus.setupNewState.onboardingTaskId ??
            onboardingTaskId);

        if (targetTaskId) {
          router.replace(`/task/${targetTaskId}`);
          return;
        }

        // Environment setup may have just written the first environment. Refresh
        // before redirecting so Home can select it via environmentId.
        let envs = environments.data;
        try {
          const refreshed = await queryClient.fetchQuery(
            trpc.environments.list.queryOptions(undefined, { staleTime: 0 }),
          );
          if (Array.isArray(refreshed)) {
            envs = refreshed;
          }
        } catch {
          // Fall back to whatever is already cached.
        }

        const params = new URLSearchParams();
        const targetEnv = envs?.[0];

        if (targetEnv) {
          params.set('environmentId', targetEnv.id);
        }

        if (linkSuggestedTasks) {
          params.set('link_suggested', 'true');
        }

        const query = params.toString();
        router.replace(query ? `/?${query}` : '/');
      },
    }),
  );
}

function ComputeProvisioningNotice({
  computeProvisioning,
  onRetryComputeProvisioning,
}: {
  computeProvisioning?: SetupNewComputeProvisioningState | null;
  onRetryComputeProvisioning?: () => void;
}) {
  return (
    <>
      {computeProvisioning?.status === 'building' ? (
        <p className="text-sm text-muted-foreground">
          The sandbox provider is still being prepared. Your environment task is
          queued and will start automatically when it is ready.
        </p>
      ) : null}
      {computeProvisioning?.status === 'failed' ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>
            <p>
              Sandbox provider provisioning failed:{' '}
              {computeProvisioning.error ??
                'The worker artifact could not be prepared.'}{' '}
              {onRetryComputeProvisioning ? (
                <button
                  type="button"
                  className="font-medium underline underline-offset-4"
                  onClick={onRetryComputeProvisioning}
                >
                  Retry provisioning
                </button>
              ) : null}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function CompletionPreferences({
  anonymousAnalyticsEnabled,
  onAnonymousAnalyticsChange,
  productUpdatesEnabled,
  onProductUpdatesChange,
}: {
  anonymousAnalyticsEnabled: boolean;
  onAnonymousAnalyticsChange: (enabled: boolean) => void;
  productUpdatesEnabled: boolean;
  onProductUpdatesChange: (enabled: boolean) => void;
}) {
  const { user } = useUser();
  const isCloudAdmin = user?.cloudEnabled && user.isAdmin;

  if (user?.cloudEnabled && isCloudAdmin) {
    return null;
  }

  return (
    <div className="space-y-2 text-sm mt-8 pl-0.5 text-foreground/80">
      {!user?.cloudEnabled && (
        <label className="flex gap-2 item-start cursor-pointer">
          <Checkbox
            aria-label="Toggle anonymous analytics"
            className="relative top-1"
            checked={anonymousAnalyticsEnabled}
            onCheckedChange={(checked) =>
              onAnonymousAnalyticsChange(checked === true)
            }
          />
          <span>
            Share anonymous stats with the {PRODUCT_NAME} team for product
            improvements.
            <br />
            No PII, code, or conversation content is ever shared.
          </span>
        </label>
      )}
      {!isCloudAdmin && (
        <label className="flex gap-2 item-start cursor-pointer">
          <Checkbox
            aria-label="Toggle product updates"
            className="mt-0.5"
            checked={productUpdatesEnabled}
            onCheckedChange={(checked) =>
              onProductUpdatesChange(checked === true)
            }
          />
          <span>Get occasional emails from Roomote with product updates.</span>
        </label>
      )}
    </div>
  );
}

type StarterTaskLaunch = {
  starterTaskId: SetupStarterTaskId;
  sessionId: string;
};

function buildLaunchErrorMessage(result: {
  failed: Array<{ starterTaskId: SetupStarterTaskId; error: string }>;
  completionError: string | null;
}) {
  const [firstFailure] = result.failed;

  if (firstFailure) {
    const failedTitles = result.failed
      .map((failure) => getSetupStarterTask(failure.starterTaskId).title)
      .join(', ');

    return `Couldn't start: ${failedTitles} (${firstFailure.error}). Press Retry to try again.`;
  }

  return `${result.completionError ?? 'Setup could not be completed.'} Press Retry to try again.`;
}

function StarterTasksStepContent({
  onTryItOut,
  linkSuggestedTasks = false,
  computeProvisioning = null,
  onRetryComputeProvisioning,
}: StepInvokeProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<SetupStarterTaskId[]>(() =>
    SETUP_STARTER_TASKS.map((starterTask) => starterTask.id),
  );
  const [launchedTasks, setLaunchedTasks] = useState<StarterTaskLaunch[]>([]);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [anonymousAnalyticsEnabled, setAnonymousAnalyticsEnabled] =
    useState(true);
  const [productUpdatesEnabled, setProductUpdatesEnabled] = useState(true);
  const isCloudAdmin = user?.cloudEnabled && user.isAdmin;

  const completeSetup = useCompleteSetupMutation({
    onboardingTaskId: null,
    linkSuggestedTasks,
  });

  const launchStarterTasks = useMutation(
    trpc.setup.completeWithStarterTasks.mutationOptions({
      onSuccess: async (result) => {
        const allLaunched = [...launchedTasks, ...(result?.launched ?? [])];
        setLaunchedTasks(allLaunched);

        if (!result || result.failed.length > 0 || !result.setupCompleted) {
          setLaunchError(
            result
              ? buildLaunchErrorMessage(result)
              : 'The tasks could not be started. Press Retry to try again.',
          );
          return;
        }

        setLaunchError(null);

        // Optimistically mark setup as completed in the cache so the
        // authenticated layout doesn't redirect back to /setup.
        queryClient.setQueryData(trpc.setup.status.queryKey(), (old) =>
          old ? { ...old, setupCompletedAt: new Date() } : old,
        );
        queryClient.setQueryData(trpc.onboarding.status.queryKey(), (old) =>
          old ? { ...old, onboardingCompletedAt: new Date() } : old,
        );

        // Leave before awaiting invalidation so /setup's completed-setup
        // guard cannot race and flash Home before the destination page.
        const [firstLaunched] = allLaunched;
        router.replace(
          allLaunched.length === 0
            ? '/'
            : allLaunched.length === 1 && firstLaunched
              ? `/sessions/${firstLaunched.sessionId}`
              : '/sessions',
        );

        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.setup.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.onboarding.status.queryKey(),
          }),
        ]);
        queryClient.removeQueries({
          queryKey: trpc.github.installations.queryKey(),
        });
      },
      onError: (error) => {
        setLaunchError(`${error.message} Press Retry to try again.`);
      },
    }),
  );

  const launchedIds = new Set(
    launchedTasks.map((launch) => launch.starterTaskId),
  );
  const remainingIds = selectedIds.filter((id) => !launchedIds.has(id));
  const isPending = completeSetup.isPending || launchStarterTasks.isPending;

  const toggleStarterTask = (id: SetupStarterTaskId, checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((candidate) => candidate !== id),
    );
  };

  const handleGo = () => {
    onTryItOut?.();

    const preferences = {
      ...(user?.cloudEnabled ? {} : { anonymousAnalyticsEnabled }),
      ...(!isCloudAdmin ? { productUpdatesEnabled } : {}),
    };

    if (remainingIds.length === 0 && launchedTasks.length === 0) {
      // Nothing selected and nothing launched: plain setup completion with
      // the existing Home routing.
      completeSetup.mutate(preferences);
      return;
    }

    setLaunchError(null);
    launchStarterTasks.mutate({
      selectedStarterTaskIds: remainingIds,
      ...preferences,
    });
  };

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={STARTER_TASKS_TITLE} />
      <p className="mb-4">
        These are a few good starter tasks to get you going, zero effort:
      </p>
      <ComputeProvisioningNotice
        computeProvisioning={computeProvisioning}
        onRetryComputeProvisioning={onRetryComputeProvisioning}
      />
      <div className="space-y-2 rounded-xl bg-card py-2 divide-y">
        {SETUP_STARTER_TASKS.map((starterTask) => {
          const isLaunched = launchedIds.has(starterTask.id);
          const checked = isLaunched || selectedIds.includes(starterTask.id);
          const inputId = `setup-starter-task-${starterTask.id}`;

          return (
            <label
              key={starterTask.id}
              htmlFor={inputId}
              className="flex cursor-pointer items-start gap-3 px-4 pt-1 pb-3 text-sm"
            >
              <Checkbox
                id={inputId}
                aria-label={starterTask.title}
                className="relative top-0.5 shrink-0"
                checked={checked}
                disabled={isLaunched || isPending}
                onCheckedChange={(nextChecked) =>
                  toggleStarterTask(starterTask.id, nextChecked === true)
                }
              />
              <span className="flex-1">
                <span className="font-semibold">{starterTask.title}</span>
                <span className="block text-muted-foreground">
                  {isLaunched ? 'Started.' : starterTask.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {launchError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{launchError}</AlertDescription>
        </Alert>
      ) : null}

      <CompletionPreferences
        anonymousAnalyticsEnabled={anonymousAnalyticsEnabled}
        onAnonymousAnalyticsChange={setAnonymousAnalyticsEnabled}
        productUpdatesEnabled={productUpdatesEnabled}
        onProductUpdatesChange={setProductUpdatesEnabled}
      />

      <div className="mt-3 flex">
        <Button onClick={handleGo} disabled={isPending}>
          {isPending && <Loader2 className="animate-spin size-4 mr-2" />}
          {launchError ? 'Retry' : 'Go'}
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function OnboardingTaskStepContent({
  onTryItOut,
  onboardingTaskId,
  linkSuggestedTasks = false,
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
  computeProvisioning = null,
  onRetryComputeProvisioning,
}: StepInvokeProps) {
  const trpc = useTRPC();
  const { user } = useUser();
  const commsStatus = useQuery(trpc.comms.status.queryOptions());
  const effectiveCommunicationProviders = [
    ...communicationProviders,
    ...(['telegram', 'discord'] as const).filter(
      (providerId) =>
        commsStatus.data?.providers?.some(
          (provider) => provider.id === providerId && provider.setupSatisfied,
        ) && !communicationProviders.includes(providerId),
    ),
  ];
  const [anonymousAnalyticsEnabled, setAnonymousAnalyticsEnabled] =
    useState(true);
  const [productUpdatesEnabled, setProductUpdatesEnabled] = useState(true);
  const isCloudAdmin = user?.cloudEnabled && user.isAdmin;
  const methods = buildInvokeMethods({
    communicationProviders: effectiveCommunicationProviders,
    sourceControlProviders,
    includeLinear,
    invocationIdentities: commsStatus.data?.invocationIdentities,
  });

  const completeSetup = useCompleteSetupMutation({
    onboardingTaskId,
    linkSuggestedTasks,
  });

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={INVOKE_STEP.title} />
      <p className="mb-4">
        {`Once your environment is configured, you can work with ${PRODUCT_NAME} in these ways (verification may still be in progress):`}
      </p>
      <ComputeProvisioningNotice
        computeProvisioning={computeProvisioning}
        onRetryComputeProvisioning={onRetryComputeProvisioning}
      />
      <div className="space-y-5">
        {methods.map((method) => (
          <div key={method.title} className="flex items-start gap-3 group">
            <method.icon className="size-5 mt-0.5 shrink-0 text-foreground transition-transform group-hover:scale-120" />
            <div className="space-y-1">
              <p className="">
                <span className="font-semibold">{method.title}: </span>
                {method.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      <CompletionPreferences
        anonymousAnalyticsEnabled={anonymousAnalyticsEnabled}
        onAnonymousAnalyticsChange={setAnonymousAnalyticsEnabled}
        productUpdatesEnabled={productUpdatesEnabled}
        onProductUpdatesChange={setProductUpdatesEnabled}
      />

      <div className="mt-3 flex">
        <Button
          onClick={() => {
            onTryItOut?.();
            completeSetup.mutate({
              ...(user?.cloudEnabled ? {} : { anonymousAnalyticsEnabled }),
              ...(!isCloudAdmin ? { productUpdatesEnabled } : {}),
            });
          }}
          disabled={completeSetup.isPending}
        >
          {completeSetup.isPending && (
            <Loader2 className="animate-spin size-4 mr-2" />
          )}
          Let&apos;s go
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

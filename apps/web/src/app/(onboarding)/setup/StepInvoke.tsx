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
import { buildInvokeMethods } from '../invokeMethods';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const INVOKE_STEP = getSetupStepDefinition('invoke');

type CommunicationProviderId = 'slack' | 'microsoft' | 'telegram' | 'discord';

export function StepInvoke({
  onTryItOut,
  onboardingTaskId,
  linkSuggestedTasks = false,
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
  computeProvisioning = null,
  onRetryComputeProvisioning,
}: {
  onTryItOut?: () => void;
  onboardingTaskId?: string | null;
  linkSuggestedTasks?: boolean;
  communicationProviders?: readonly CommunicationProviderId[];
  sourceControlProviders?: readonly SourceControlProvider[];
  includeLinear?: boolean;
  computeProvisioning?: SetupNewComputeProvisioningState | null;
  onRetryComputeProvisioning?: () => void;
} = {}) {
  const router = useRouter();
  const trpc = useTRPC();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const environments = useEnvironments({ enabled: !onboardingTaskId });
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

  const completeSetup = useMutation(
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
        const targetTaskId =
          refreshedSetupNewStatus.setupNewState.onboardingTaskId ??
          onboardingTaskId;

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

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={INVOKE_STEP.title} />
      <p className="mb-4">
        {onboardingTaskId
          ? `Once your environment is configured, you can work with ${PRODUCT_NAME} in these ways (verification may still be in progress):`
          : `How to work with ${PRODUCT_NAME}:`}
      </p>
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

      {(!user?.cloudEnabled || !isCloudAdmin) && (
        <div className="space-y-2 text-sm mt-8 pl-0.5 text-foreground/80">
          {!user?.cloudEnabled && (
            <label className="flex gap-2 item-start cursor-pointer">
              <Checkbox
                aria-label="Toggle anonymous analytics"
                className="relative top-1"
                checked={anonymousAnalyticsEnabled}
                onCheckedChange={(checked) =>
                  setAnonymousAnalyticsEnabled(checked === true)
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
                  setProductUpdatesEnabled(checked === true)
                }
              />
              <span>
                Get occasional emails from Roomote with product updates.
              </span>
            </label>
          )}
        </div>
      )}

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
          {onboardingTaskId ? 'Finish environment setup' : "Let's go"}
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

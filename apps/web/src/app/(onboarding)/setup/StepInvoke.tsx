'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT_NAME } from '@roomote/types';
import type { SourceControlProvider } from '@roomote/types';
import {
  Button,
  Loader2,
  ArrowRight,
  Checkbox,
  CornerDownRight,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { useEnvironments } from '@/hooks/environments/useEnvironments';
import { buildInvokeMethods } from '../invokeMethods';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const INVOKE_STEP = getSetupStepDefinition('invoke');

type CommunicationProviderId = 'slack' | 'microsoft' | 'telegram';

export function StepInvoke({
  onTryItOut,
  onboardingTaskId,
  linkSuggestedTasks = false,
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
}: {
  onTryItOut?: () => void;
  onboardingTaskId?: string | null;
  linkSuggestedTasks?: boolean;
  communicationProviders?: readonly CommunicationProviderId[];
  sourceControlProviders?: readonly SourceControlProvider[];
  includeLinear?: boolean;
} = {}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const environments = useEnvironments({ enabled: !onboardingTaskId });
  const commsStatus = useQuery(trpc.comms.status.queryOptions());
  const effectiveCommunicationProviders = [
    ...communicationProviders,
    ...(commsStatus.data?.providers?.some(
      (provider) => provider.id === 'telegram' && provider.setupSatisfied,
    ) && !communicationProviders.includes('telegram')
      ? (['telegram'] as const)
      : []),
  ];
  const [anonymousAnalyticsEnabled, setAnonymousAnalyticsEnabled] =
    useState(true);
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

        const envs = environments.data;
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
          ? `Once your environment is ready, you can work with ${PRODUCT_NAME} in these ways:`
          : `How to work with ${PRODUCT_NAME}:`}
      </p>
      <div className="space-y-5">
        {methods.map((method) => (
          <div key={method.title} className="flex items-start gap-3 group">
            <method.icon className="size-5 mt-0.5 shrink-0 text-foreground transition-transform group-hover:scale-120" />
            <div className="space-y-0">
              <p className="">
                <span className="font-semibold">{method.title}: </span>
                {method.description}
              </p>
              {'example' in method && (
                <p className="text-[0.9em] text-foreground font-mono cursor-default group-hover:text-foreground py-1.5">
                  <CornerDownRight className="inline size-4 mr-2 relative -top-0.5" />
                  {method.example}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-start gap-2 border-t border-foreground/20 pt-4">
        <Checkbox
          aria-label="Toggle anonymous analytics"
          className="mt-0.5"
          checked={anonymousAnalyticsEnabled}
          onCheckedChange={(checked) =>
            setAnonymousAnalyticsEnabled(checked === true)
          }
        />
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">Anonymous analytics</p>
          <p className="text-sm text-muted-foreground">
            Share usage stats with the {PRODUCT_NAME} team for product
            improvements.
            <br />
            No PII, code or conversation content is ever shared. Accrues good
            karma.
          </p>
        </div>
      </div>

      <div className="mt-3 flex">
        <Button
          className="w-full sm:w-auto"
          onClick={() => {
            onTryItOut?.();
            completeSetup.mutate({ anonymousAnalyticsEnabled });
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

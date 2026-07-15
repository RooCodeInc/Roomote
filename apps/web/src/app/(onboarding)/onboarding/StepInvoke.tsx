'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT_NAME } from '@roomote/types';
import type {
  SetupAuthProviderId,
  SourceControlProvider,
} from '@roomote/types';
import { Button, Loader2, ArrowRight } from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { useEnvironments } from '@/hooks/environments/useEnvironments';
import { StepCompletedBadge } from '../setup/StepCompletedBadge';
import { StepTitle } from '../setup/StepTitle';
import { buildInvokeMethods } from '../invokeMethods';

export function StepInvoke({
  previousStepCompleted,
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
}: {
  previousStepCompleted?: string;
  communicationProviders?: readonly SetupAuthProviderId[];
  sourceControlProviders?: readonly SourceControlProvider[];
  includeLinear?: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const environments = useEnvironments();
  const commsStatus = useQuery(trpc.comms.status.queryOptions());
  const methods = buildInvokeMethods({
    communicationProviders,
    sourceControlProviders,
    includeLinear,
    invocationIdentities: commsStatus.data?.invocationIdentities,
  });

  const completeOnboarding = useMutation(
    trpc.onboarding.complete.mutationOptions({
      onSuccess: async () => {
        // Optimistically mark onboarding as completed in the cache so the
        // authenticated layout doesn't redirect back to /onboarding.
        queryClient.setQueryData(trpc.onboarding.status.queryKey(), (old) =>
          old ? { ...old, onboardingCompletedAt: new Date() } : old,
        );

        await queryClient.invalidateQueries({
          queryKey: trpc.onboarding.status.queryKey(),
        });

        // Remove cached query data so the home page loads fresh.
        queryClient.removeQueries({
          queryKey: trpc.github.installations.queryKey(),
        });

        const envs = environments.data;
        const targetEnv = envs?.[0];

        if (targetEnv) {
          router.replace(`/?environmentId=${targetEnv.id}`);
        } else {
          router.replace('/');
        }
      },
    }),
  );

  return (
    <div className="space-y-6 max-w-xl relative">
      {previousStepCompleted && (
        <StepCompletedBadge text={previousStepCompleted} />
      )}
      <StepTitle text="You're all set!" showCheckbox={false} />
      <p className="text-sm mb-4">How to work with {PRODUCT_NAME}:</p>
      <div className="space-y-4">
        {methods.map((method) => (
          <div
            key={method.title}
            className="flex items-start gap-3 text-sm group"
          >
            <method.icon className="size-5 mt-0.5 shrink-0 text-muted-foreground transition-transform group-hover:scale-120" />
            <div className="space-y-1">
              <p className="font-medium">{method.title}</p>
              <p className="text-sm text-muted-foreground cursor-default group-hover:text-foreground">
                {method.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex mt-3">
        <Button
          onClick={() => completeOnboarding.mutate()}
          disabled={completeOnboarding.isPending}
        >
          {completeOnboarding.isPending && (
            <Loader2 className="animate-spin size-4 mr-2" />
          )}
          Try it out
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

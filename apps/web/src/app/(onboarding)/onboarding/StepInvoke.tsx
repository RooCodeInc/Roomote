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
  Card,
  CardContent,
  Checkbox,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { useUser } from '@/hooks/useUser';
import { StepTitle } from '../setup/StepTitle';
import { buildInvokeMethods } from '../invokeMethods';

type OnboardingCommunicationProvider =
  | 'slack'
  | 'microsoft'
  | 'telegram'
  | 'discord';

export function StepInvoke({
  communicationProviders = [],
  sourceControlProviders = [],
  includeAutomations = true,
}: {
  communicationProviders?: readonly OnboardingCommunicationProvider[];
  sourceControlProviders?: readonly SourceControlProvider[];
  includeAutomations?: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const [productUpdatesEnabled, setProductUpdatesEnabled] = useState(true);
  const isCloudAdmin = user?.cloudEnabled && user.isAdmin;
  const commsStatus = useQuery(trpc.comms.status.queryOptions());
  const methods = buildInvokeMethods({
    communicationProviders,
    sourceControlProviders,
    includeAutomations,
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

        router.replace('/');
      },
    }),
  );

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text="You're all set!" showCheckbox={false} />
      <p>How to work with {PRODUCT_NAME}:</p>
      <div className="space-y-5">
        {methods.map((method) => (
          <div key={method.title} className="flex items-start gap-3 group">
            <method.icon className="size-5 mt-0.5 shrink-0 text-foreground transition-transform group-hover:scale-120" />
            <div className="space-y-1">
              <p>
                <span className="font-semibold">{method.title}: </span>
                {method.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      {!isCloudAdmin && (
        <Card>
          <CardContent className="space-y-4">
            <p className="text-sm font-semibold">Optional preferences</p>
            <div className="flex items-start gap-2">
              <Checkbox
                aria-label="Toggle product updates"
                className="mt-0.5"
                checked={productUpdatesEnabled}
                onCheckedChange={(checked) =>
                  setProductUpdatesEnabled(checked === true)
                }
              />
              <div className="space-y-0.5">
                <p className="text-sm font-semibold">Product updates</p>
                <p className="text-sm text-muted-foreground">
                  Get occasional Roomote product news and updates.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex mt-3">
        <Button
          onClick={() =>
            completeOnboarding.mutate(
              isCloudAdmin ? {} : { productUpdatesEnabled },
            )
          }
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

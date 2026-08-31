'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComputeProvider } from '@roomote/types';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { Container } from '@/components/system';

import { StepComputeConfig } from './StepComputeConfig';
import { StepComputeProvider } from './StepComputeProvider';
import { SetupSessionActionCard } from './SetupSessionActionCard';

/**
 * Inline sandbox setup for the conversational setup session. Runtime/env-var
 * configured providers make the compute status ready and therefore never show
 * this card. Otherwise, starter work remains persisted as intent while this
 * trusted provider/configuration UI is completed.
 */
export function SetupSandboxInlineCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] =
    useState<ComputeProvider | null>(null);
  const statusQuery = useQuery(
    trpc.setupNew.status.queryOptions(undefined, {
      refetchInterval: 2_000,
      staleTime: 1_000,
    }),
  );
  const saveProviderChoice = useMutation(
    trpc.setupNew.saveComputeProviderChoice.mutationOptions({
      onSuccess: async (_result, variables) => {
        setSelectedProvider(variables.provider);
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const computeSetup = statusQuery.data?.computeSetup;
  const setupSessionHasStarterSelection = Boolean(
    statusQuery.data?.setupNewState.setupSession?.starterTaskSelection,
  );
  const computeReady = computeSetup?.setupSatisfied === true;

  // A provisioning completion can make the card disappear on the next status
  // poll. Fetching sessionStatus here ensures that poll also reconciles and
  // schedules the durable starter launch before this component unmounts.
  useEffect(() => {
    if (!computeReady) return;
    void queryClient.fetchQuery(trpc.setup.sessionStatus.queryOptions());
  }, [computeReady, queryClient, trpc.setup.sessionStatus]);

  if (!computeSetup || computeReady || !setupSessionHasStarterSelection) {
    return null;
  }

  const effectiveProvider =
    selectedProvider ?? computeSetup.selectedProvider ?? null;

  return (
    <SetupSessionActionCard
      title="Set up a sandbox"
      icon={<Container className="size-4" />}
      intro="Choose where I should run the work you selected. This is a one-time setup for this deployment."
    >
      {effectiveProvider ? (
        <StepComputeConfig
          computeSetup={computeSetup}
          selectedProviderId={effectiveProvider}
          onContinue={() => {
            void queryClient.invalidateQueries({
              queryKey: trpc.setupNew.status.queryKey(),
            });
          }}
          onBack={() => setSelectedProvider(null)}
          embedded
        />
      ) : (
        <StepComputeProvider
          computeSetup={computeSetup}
          onContinue={(provider) => saveProviderChoice.mutate({ provider })}
          disabled={saveProviderChoice.isPending}
          embedded
        />
      )}
    </SetupSessionActionCard>
  );
}

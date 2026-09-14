'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComputeProvider } from '@roomote/types';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { Container } from '@/components/system';
import { Button } from '@/components/system';

import { SandboxConfiguration } from './SandboxConfiguration';
import { SandboxProviderPicker } from './SandboxProviderPicker';
import { SetupSessionActionCard } from './SetupSessionActionCard';

/**
 * Inline sandbox setup for the conversational setup session. Runtime/env-var
 * configured providers make the compute status ready and therefore never show
 * this card. Otherwise, this trusted provider/configuration UI appears only
 * after the administrator selects coding work that needs to launch.
 */
export function SetupSandboxCard({
  forceVisible = false,
  onDismiss,
}: {
  forceVisible?: boolean;
  onDismiss?: () => void;
} = {}) {
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
  const computeReady = computeSetup?.setupSatisfied === true;
  const selectedStarterTaskIds =
    statusQuery.data?.setupNewState.setupSession?.starterTaskSelection?.taskIds;
  const hasSynchronizedRepository =
    statusQuery.data?.sourceControlSetup.providers.some(
      (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
    );

  // A provisioning completion can make the card disappear on the next status
  // poll. Fetching sessionStatus here ensures that poll also reconciles and
  // schedules the durable starter launch before this component unmounts.
  useEffect(() => {
    if (!computeReady) return;
    void queryClient.fetchQuery(trpc.setup.sessionStatus.queryOptions());
  }, [computeReady, queryClient, trpc.setup.sessionStatus]);

  if (
    !computeSetup ||
    computeReady ||
    (!forceVisible &&
      (!hasSynchronizedRepository || !selectedStarterTaskIds?.length))
  ) {
    return null;
  }

  const effectiveProvider =
    selectedProvider ?? computeSetup.selectedProvider ?? null;

  return (
    <SetupSessionActionCard
      title="I need a sandbox to run tasks"
      icon={<Container />}
      intro="Tasks run in isolated VMs called sandboxes, where I can verify my work."
    >
      {effectiveProvider ? (
        <SandboxConfiguration
          computeSetup={computeSetup}
          selectedProviderId={effectiveProvider}
          onContinue={() => {
            void queryClient.invalidateQueries({
              queryKey: trpc.setupNew.status.queryKey(),
            });
          }}
          onBack={() => setSelectedProvider(null)}
        />
      ) : (
        <SandboxProviderPicker
          computeSetup={computeSetup}
          onContinue={(provider) => saveProviderChoice.mutate({ provider })}
          disabled={saveProviderChoice.isPending}
        />
      )}
      {onDismiss ? (
        <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
          Not now
        </Button>
      ) : null}
    </SetupSessionActionCard>
  );
}

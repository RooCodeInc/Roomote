'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  SetupSourceControlStatus,
  SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { buildSetupSessionSourceControlReturnTarget } from '@/lib/server/source-control-oauth-redirect';
import {
  ArrowRight,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  GitBranch,
} from '@/components/system';

import { SetupSessionActionCard } from './SetupSessionActionCard';
import { SourceControlConfiguration } from './SourceControlConfiguration';
import { SourceControlConnection } from './SourceControlConnection';
import { SourceControlProviderPicker } from './SourceControlProviderPicker';

type CardStage = 'provider' | 'config' | 'connect';

/**
 * Trusted source-control action for the conversational setup session.
 *
 * Provider configuration remains trusted UI, but detailed provider-specific
 * instructions and credentials live in a dialog so they do not overwhelm the
 * conversation card.
 */
function SetupSessionSourceControlCardBody({
  sourceControlSetup,
  sessionId,
}: {
  sourceControlSetup: SetupSourceControlStatus;
  sessionId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const anyAuthorized =
    Boolean(sourceControlSetup.connectedProvider) ||
    sourceControlSetup.providers.some((provider) => provider.connected);
  const hasSelected =
    Boolean(sourceControlSetup.selectedProvider) ||
    Boolean(sourceControlSetup.runtimeConfiguredProvider);
  const [stage, setStage] = useState<CardStage>(() =>
    anyAuthorized ||
    searchParams.get('step') === 'source-control-connect' ||
    searchParams.get('setup') === 'source-control'
      ? 'connect'
      : hasSelected
        ? 'config'
        : 'provider',
  );
  const [configOpen, setConfigOpen] = useState(false);
  const [activeProvider, setActiveProvider] =
    useState<SourceControlProvider | null>(null);
  const saveSourceControlProviderChoice = useMutation(
    trpc.setupNew.saveSourceControlProviderChoice.mutationOptions({
      onSuccess: async (_result, variables) => {
        setActiveProvider(variables.provider);
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        setStage('config');
        setConfigOpen(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const provider =
    activeProvider ??
    sourceControlSetup.selectedProvider ??
    sourceControlSetup.runtimeConfiguredProvider ??
    sourceControlSetup.preselectedProvider;
  const providerLabel =
    sourceControlSetup.providers.find(
      (candidate) => candidate.provider === provider,
    )?.label ?? provider;
  const returnPath = buildSetupSessionSourceControlReturnTarget({
    sessionId,
    provider,
  });
  const oauthError =
    searchParams.get(provider) === 'error'
      ? searchParams.get('reason') || `${provider} authorization was cancelled.`
      : null;

  const cardTitle =
    stage === 'provider'
      ? 'Connect source control'
      : stage === 'config'
        ? `Set up ${providerLabel}`
        : `Authorize ${providerLabel}`;
  const cardIntro =
    stage === 'provider'
      ? 'Connect the service that hosts your repositories so I can work on your code.'
      : stage === 'config'
        ? `Add the ${providerLabel} app credentials. The detailed setup opens in a separate dialog.`
        : `Give me access to ${providerLabel} and sync the repositories I can work with.`;

  return (
    <SetupSessionActionCard
      title={cardTitle}
      icon={<GitBranch />}
      intro={cardIntro}
    >
      {oauthError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {oauthError}
        </p>
      ) : null}
      {stage === 'provider' ? (
        <SourceControlProviderPicker
          sourceControlSetup={sourceControlSetup}
          onContinue={(nextProvider) =>
            saveSourceControlProviderChoice.mutate({ provider: nextProvider })
          }
          disabled={saveSourceControlProviderChoice.isPending}
        />
      ) : stage === 'config' ? (
        <>
          <Button type="button" onClick={() => setConfigOpen(true)}>
            Configure {providerLabel}
            <ArrowRight />
          </Button>
          <Dialog open={configOpen} onOpenChange={setConfigOpen}>
            <DialogContent size="2xl">
              <DialogHeader>
                <DialogTitle>Configure {providerLabel}</DialogTitle>
                <DialogDescription>
                  Follow the provider-specific steps, then save the credentials
                  to continue connecting your repositories.
                </DialogDescription>
              </DialogHeader>
              <SourceControlConfiguration
                sourceControlSetup={sourceControlSetup}
                selectedProviderId={provider}
                onContinue={() => {
                  setConfigOpen(false);
                  setStage('connect');
                }}
                returnPath={returnPath}
              />
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <SourceControlConnection
          sourceControlSetup={sourceControlSetup}
          onContinue={() => {
            void queryClient.invalidateQueries({
              queryKey: trpc.setupNew.status.queryKey(),
            });
          }}
          onBack={() => setStage('config')}
          returnPath={returnPath}
        />
      )}
    </SetupSessionActionCard>
  );
}

export function SetupSessionSourceControlCard({
  sessionId,
}: {
  sessionId: string;
}) {
  const trpc = useTRPC();
  const statusQuery = useQuery(
    trpc.setupNew.status.queryOptions(undefined, { staleTime: 10_000 }),
  );
  const sourceControlSetup = statusQuery.data?.sourceControlSetup ?? null;
  const hasSynchronizedRepository = sourceControlSetup?.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );

  if (!sourceControlSetup || hasSynchronizedRepository) {
    return null;
  }

  return (
    <SetupSessionSourceControlCardBody
      sourceControlSetup={sourceControlSetup}
      sessionId={sessionId}
    />
  );
}

'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  isSourceControlTokenBackedProvider,
  type SetupSourceControlStatus,
  type SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { Button, Github, Spinner } from '@/components/system';
import { useCreateGitHubInstallation } from '@/hooks/github/useCreateGitHubInstallation';
import { useSyncRepositories } from '@/hooks/source-control/useSyncRepositories';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const SOURCE_CONTROL_CONNECT_STEP = getSetupStepDefinition(
  'source-control-connect',
);

function getTokenBackedWebhookResource(
  provider: SourceControlProvider,
): string {
  return provider === 'gitlab' ? 'project' : 'repository';
}

function getTokenBackedConnectCopy({
  lockedByRuntime,
  provider,
  providerLabel,
}: {
  lockedByRuntime: boolean;
  provider: SourceControlProvider;
  providerLabel: string;
}): string {
  if (lockedByRuntime) {
    return `Roomote needs access to your repositories to work on your codebase. Since ${providerLabel} is already configured, let's go with it.`;
  }

  switch (provider) {
    case 'gitlab':
      return 'Sync your GitLab projects so Roomote can access your codebase. Roomote also configures merge request webhooks on the synced projects so it can review merge requests automatically.';
    case 'gitea':
      return 'Sync your Gitea repositories so Roomote can access your codebase. Roomote also configures pull request webhooks on the synced repositories so it can review pull requests automatically.';
    case 'bitbucket':
      return 'Sync your Bitbucket repositories so Roomote can access your codebase. Roomote also configures pull request webhooks on the synced repositories so it can review pull requests automatically.';
    case 'ado':
      return 'Sync your Azure DevOps repositories so Roomote can access your codebase. Roomote also configures pull request service hooks on the synced repositories so it can review pull requests automatically.';
    default:
      return `Sync your ${providerLabel} repositories so Roomote can access your codebase.`;
  }
}

export function StepSourceControlConnect({
  sourceControlSetup,
  onContinue,
}: {
  sourceControlSetup: SetupSourceControlStatus;
  onContinue: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const provider: SourceControlProvider =
    sourceControlSetup.selectedProvider ??
    sourceControlSetup.runtimeConfiguredProvider ??
    sourceControlSetup.preselectedProvider;
  const providerStatus = sourceControlSetup.providers.find(
    (candidate) => candidate.provider === provider,
  );
  const [syncedWithZeroRepos, setSyncedWithZeroRepos] = useState(false);

  const createInstallation = useCreateGitHubInstallation({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () => toast.error('Failed to connect GitHub. Please try again.'),
  });

  const syncRepositories = useSyncRepositories(
    isSourceControlTokenBackedProvider(provider) ? provider : 'gitlab',
    {
      onSuccess: async (data) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.sourceControl.repositories.queryKey(),
        });

        if ('success' in data && data.success === false) {
          toast.error(data.error ?? 'Repository sync failed.');
          return;
        }

        if ('webhooks' in data && data.webhooks) {
          if (data.webhooks.status === 'skipped') {
            toast.info(`Webhooks were not configured: ${data.webhooks.reason}`);
          } else if (data.webhooks.failed.length > 0) {
            const webhookResource = getTokenBackedWebhookResource(provider);

            toast.warning(
              `Webhook setup failed on ${data.webhooks.failed.length} ${
                data.webhooks.failed.length === 1
                  ? webhookResource
                  : `${webhookResource}s`
              }. You can retry from Settings after fixing token permissions.`,
            );
          }
        }

        const refreshed = await queryClient.ensureQueryData(
          trpc.setupNew.status.queryOptions(undefined, { staleTime: 0 }),
        );

        const refreshedProvider = refreshed.sourceControlSetup.providers.find(
          (candidate) => candidate.provider === provider,
        );

        if (refreshedProvider?.connected) {
          onContinue();
        } else {
          setSyncedWithZeroRepos(true);
        }
      },
      onError: () =>
        toast.error('Failed to sync repositories. Please try again.'),
    },
  );

  const alreadyConnected = providerStatus?.connected === true;
  const lockedByRuntime = sourceControlSetup.lockReason === 'runtime_env';
  const providerLabel = providerStatus?.label ?? provider;
  const githubCopy = lockedByRuntime
    ? "Roomote needs access to your repositories to work on your codebase. Since GitHub is already configured, let's go with it."
    : 'Connect the GitHub App to grant Roomote access to your repositories.';

  const tokenBackedCopy = getTokenBackedConnectCopy({
    lockedByRuntime,
    provider,
    providerLabel,
  });

  return (
    <div className="relative w-full max-w-lg space-y-6 py-2 md:py-0">
      <StepTitle text={SOURCE_CONTROL_CONNECT_STEP.title} />

      {alreadyConnected ? (
        <div className="space-y-4">
          <p>
            {providerStatus?.label ?? provider} is connected with{' '}
            {providerStatus?.repositoryCount ?? 0}{' '}
            {(providerStatus?.repositoryCount ?? 0) === 1
              ? 'repository'
              : 'repositories'}
            .
          </p>
          <Button onClick={onContinue}>Continue</Button>
        </div>
      ) : provider === 'github' ? (
        <div className="space-y-4">
          <p>{githubCopy}</p>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <Button
              className="w-full sm:w-auto"
              onClick={() =>
                createInstallation.mutate(
                  `${window.location.pathname}?step=source-control-connect`,
                )
              }
              disabled={createInstallation.isPending}
            >
              {createInstallation.isPending ? <Spinner /> : <Github />}
              Connect to GitHub
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p>{tokenBackedCopy}</p>
          {syncedWithZeroRepos ? (
            <p className="text-sm text-muted-foreground">
              No repositories were found. Check your token permissions and base
              URL, then try again.
            </p>
          ) : null}
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <Button
              className="w-full sm:w-auto"
              onClick={() => syncRepositories.mutate()}
              disabled={syncRepositories.isPending}
            >
              {syncRepositories.isPending ? <Spinner /> : null}
              Sync repositories
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  isSourceControlTokenBackedProvider,
  type SetupSourceControlStatus,
  type SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  BrandIcon,
  Button,
  Github,
  RefreshCcw,
  Spinner,
} from '@/components/system';
import { useCreateGitHubInstallation } from '@/hooks/github/useCreateGitHubInstallation';
import { useGitHubPendingInstallations } from '@/hooks/github';
import { GitHubInstallRequestPending } from '@/components/github/GitHubInstallRequestPending';
import {
  useAdoLinkedAccount,
  useAuthenticateAdoAccount,
} from '@/hooks/linked-accounts';
import { useSyncRepositories } from '@/hooks/source-control/useSyncRepositories';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
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
    return "We've got all the config we need, just connect to continue.";
  }

  switch (provider) {
    case 'gitlab':
      return 'Sync your GitLab projects so Roomote can access your codebase.';
    case 'gitea':
      return 'Sync your Gitea repositories so Roomote can access your codebase.';
    case 'bitbucket':
      return 'Sync your Bitbucket Cloud repositories so Roomote can access your codebase.';
    case 'ado':
      return 'Sync your Azure DevOps repositories so Roomote can access your codebase.';
    default:
      return `Sync your ${providerLabel} repositories so Roomote can access your codebase.`;
  }
}

export function StepSourceControlConnect({
  sourceControlSetup,
  onContinue,
  onRemoveSyncMarker,
  onBack,
  returnPath,
}: {
  sourceControlSetup: SetupSourceControlStatus;
  onContinue: () => void;
  onRemoveSyncMarker?: () => void;
  onBack?: () => void;
  returnPath?: string;
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
  const adoLinkedAccount = useAdoLinkedAccount();
  const authenticateAdoAccount = useAuthenticateAdoAccount();
  const saveAdoLinkedAccount = useMutation(
    trpc.sourceControl.saveConfig.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const startRecommendations = useMutation(
    trpc.automations.startRecommendations.mutationOptions(),
  );

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
        await queryClient.invalidateQueries({
          queryKey: trpc.setup.sessionStatus.queryKey(),
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
          startRecommendations.mutate();
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

  // A non-owner can't install the GitHub App themselves; they request it and
  // wait for an org owner to approve. Surface that pending state here too, so a
  // user who returns to setup (rather than the OAuth callback) isn't dropped
  // back onto a bare "Connect to GitHub" button that restarts the request.
  const githubPendingInstallations = useGitHubPendingInstallations({
    enabled: provider === 'github' && !alreadyConnected,
  });
  const githubInstallRequestPending =
    provider === 'github' &&
    !alreadyConnected &&
    githubPendingInstallations.data?.pending === true;

  const advancedAfterApprovalRef = useRef(false);
  const handleGitHubInstallApproved = useCallback(async () => {
    if (advancedAfterApprovalRef.current) {
      return;
    }
    advancedAfterApprovalRef.current = true;

    await queryClient.invalidateQueries({
      queryKey: trpc.setupNew.status.queryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.sourceControl.repositories.queryKey(),
    });

    onContinue();
  }, [onContinue, queryClient, trpc]);

  // The parent and `GitHubInstallRequestPending` share one pending-install
  // query, so when polling flips `pending` to false the parent would unmount
  // the child before its approval effect could advance the wizard. Latch that
  // we saw a pending request and own the pending -> approved transition here so
  // approval reliably continues instead of snapping back to "Connect to GitHub".
  const [sawInstallRequestPending, setSawInstallRequestPending] =
    useState(false);
  useEffect(() => {
    if (githubInstallRequestPending) {
      setSawInstallRequestPending(true);
    }
  }, [githubInstallRequestPending]);

  useEffect(() => {
    if (
      sawInstallRequestPending &&
      provider === 'github' &&
      githubPendingInstallations.data?.pending === false
    ) {
      void handleGitHubInstallApproved();
    }
  }, [
    githubPendingInstallations.data?.pending,
    handleGitHubInstallApproved,
    provider,
    sawInstallRequestPending,
  ]);

  const showGitHubInstallPending =
    provider === 'github' &&
    !alreadyConnected &&
    (githubInstallRequestPending || sawInstallRequestPending);
  const adoAuthMode = providerStatus?.fields.find(
    (field) => field.envVarName === 'ADO_AUTH_MODE',
  )?.savedValue;
  const needsAdoMicrosoftConnection =
    provider === 'ado' &&
    adoAuthMode === 'delegated' &&
    !adoLinkedAccount.data?.account;
  // Scope the runtime-configured copy to the provider the user actually
  // landed on. A different provider being configured by env vars must not make
  // an unconfigured selected provider claim it is already configured.
  const lockedByRuntime = providerStatus?.configSatisfiedByRuntimeEnv === true;
  const providerLabel = providerStatus?.label ?? provider;
  const githubCopy = lockedByRuntime
    ? "We've got all the config we need, just connect to continue."
    : 'Connect the GitHub App to grant Roomote access to your repositories.';

  const tokenBackedCopy = getTokenBackedConnectCopy({
    lockedByRuntime,
    provider,
    providerLabel,
  });
  const gitlabOAuthConfigured =
    provider === 'gitlab' &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'GITLAB_CLIENT_ID' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    ) &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'GITLAB_CLIENT_SECRET' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    );
  const giteaOAuthConfigured =
    provider === 'gitea' &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'GITEA_CLIENT_ID' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    ) &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'GITEA_CLIENT_SECRET' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    );
  const bitbucketOAuthConfigured =
    provider === 'bitbucket' &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'BITBUCKET_CLIENT_ID' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    ) &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'BITBUCKET_CLIENT_SECRET' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    );

  const oauthAutoSyncMarkerPresent =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('sync') === '1';
  // `configStepSatisfied` rather than `configSatisfied`: delegated Azure DevOps
  // only satisfies the latter once `ADO_LINKED_ACCOUNT_ID` is saved, and saving
  // it is what `handleSyncRepositories` does below. Requiring it here would
  // strand the user on a manual "Sync repositories" button immediately after a
  // successful Microsoft sign-in. `needsAdoMicrosoftConnection` still holds the
  // auto-sync back until an account is actually linked.
  const shouldAutoSync =
    isSourceControlTokenBackedProvider(provider) &&
    providerStatus?.configStepSatisfied === true &&
    !alreadyConnected &&
    !needsAdoMicrosoftConnection &&
    (provider !== 'gitlab' ||
      !gitlabOAuthConfigured ||
      oauthAutoSyncMarkerPresent) &&
    (provider !== 'gitea' ||
      !giteaOAuthConfigured ||
      oauthAutoSyncMarkerPresent) &&
    (provider !== 'bitbucket' ||
      !bitbucketOAuthConfigured ||
      oauthAutoSyncMarkerPresent);

  const handleSyncRepositories = useCallback(async () => {
    if (
      provider === 'ado' &&
      adoAuthMode === 'delegated' &&
      adoLinkedAccount.data?.account
    ) {
      try {
        await saveAdoLinkedAccount.mutateAsync({
          provider: 'ado',
          values: {
            ADO_AUTH_MODE: 'delegated',
            ADO_LINKED_ACCOUNT_ID: adoLinkedAccount.data.account.accountId,
          },
        });
      } catch {
        // The save verifies the connection against Azure DevOps, so a failure
        // here (already surfaced by onError) means the sync would fail too.
        return;
      }
    }

    syncRepositories.mutate();
  }, [
    adoAuthMode,
    adoLinkedAccount.data?.account,
    provider,
    saveAdoLinkedAccount,
    syncRepositories,
  ]);

  const autoSyncAttempted = useRef(false);
  useEffect(() => {
    if (!shouldAutoSync || autoSyncAttempted.current) {
      return;
    }

    autoSyncAttempted.current = true;
    void handleSyncRepositories();

    if (oauthAutoSyncMarkerPresent) {
      onRemoveSyncMarker?.();
    }
  }, [
    handleSyncRepositories,
    oauthAutoSyncMarkerPresent,
    onRemoveSyncMarker,
    shouldAutoSync,
  ]);

  useEffect(() => {
    if (
      !oauthAutoSyncMarkerPresent ||
      !alreadyConnected ||
      needsAdoMicrosoftConnection
    ) {
      return;
    }

    onRemoveSyncMarker?.();
    onContinue();
  }, [
    alreadyConnected,
    needsAdoMicrosoftConnection,
    oauthAutoSyncMarkerPresent,
    onContinue,
    onRemoveSyncMarker,
  ]);

  return (
    <div className="relative w-full max-w-lg space-y-6 py-2 md:py-0">
      <StepTitle text={SOURCE_CONTROL_CONNECT_STEP.title} />

      {alreadyConnected && !needsAdoMicrosoftConnection ? (
        <div className="space-y-4">
          <p>
            {providerStatus?.label ?? provider} is connected with{' '}
            {providerStatus?.repositoryCount ?? 0}{' '}
            {(providerStatus?.repositoryCount ?? 0) === 1
              ? 'repository'
              : 'repositories'}
            .
          </p>
          <SetupFooter onBack={onBack}>
            <Button onClick={onContinue}>Continue</Button>
          </SetupFooter>
        </div>
      ) : needsAdoMicrosoftConnection ? (
        <div className="space-y-4">
          <p>
            Connect your Azure DevOps account with Microsoft before syncing
            repositories.
          </p>
          <SetupFooter onBack={onBack}>
            {adoLinkedAccount.isPending ? (
              <Spinner />
            ) : adoLinkedAccount.data?.configured === false ? (
              <p className="text-sm text-destructive">
                The Microsoft Entra service-principal settings are not ready
                yet. Go back and save the Azure DevOps app credentials first.
              </p>
            ) : (
              <Button
                onClick={() =>
                  authenticateAdoAccount.mutate(
                    returnPath ??
                      `${window.location.pathname}?step=source-control-connect`,
                  )
                }
                disabled={authenticateAdoAccount.isPending}
              >
                {authenticateAdoAccount.isPending ? (
                  <Spinner />
                ) : (
                  <BrandIcon name="ADO" icon="ado" />
                )}
                Connect with your Microsoft account
              </Button>
            )}
          </SetupFooter>
        </div>
      ) : provider === 'github' && showGitHubInstallPending ? (
        <div className="space-y-4">
          <GitHubInstallRequestPending
            onApproved={handleGitHubInstallApproved}
          />
          <SetupFooter onBack={onBack} />
        </div>
      ) : provider === 'github' ? (
        <div className="space-y-4">
          <p>{githubCopy}</p>
          <SetupFooter onBack={onBack}>
            <Button
              onClick={() =>
                createInstallation.mutate(
                  returnPath ??
                    `${window.location.pathname}?step=source-control-connect`,
                )
              }
              disabled={createInstallation.isPending}
            >
              {createInstallation.isPending ? <Spinner /> : <Github />}
              Connect to GitHub
            </Button>
          </SetupFooter>
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
          <SetupFooter onBack={onBack}>
            <Button
              onClick={() => void handleSyncRepositories()}
              disabled={
                syncRepositories.isPending || saveAdoLinkedAccount.isPending
              }
            >
              {syncRepositories.isPending || saveAdoLinkedAccount.isPending ? (
                <Spinner />
              ) : (
                <RefreshCcw />
              )}
              Sync repositories
            </Button>
          </SetupFooter>
        </div>
      )}
    </div>
  );
}

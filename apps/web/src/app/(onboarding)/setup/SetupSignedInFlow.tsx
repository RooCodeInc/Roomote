'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  getSetupNewComputeProvisioningState,
  isComputeCredentialField,
  isSetupProvisionableComputeProvider,
  type ComputeProvider,
  type SetupModelProviderId,
  type SourceControlProvider,
} from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import {
  DEFAULT_SETUP_REDIRECT_PATH,
  getSetupRedirectPath,
} from '@/lib/setup-status';
import { useTRPC } from '@/trpc/client';
import { Button } from '@/components/system';

import { StepWelcome } from './StepWelcome';
import { StepAuthEnvVars } from './StepAuthEnvVars';
import {
  StepAuthProvider,
  type CommunicationProviderChoice,
} from './StepAuthProvider';
import { StepTelegramSetup } from './StepTelegramSetup';
import { StepDiscordSetup } from './StepDiscordSetup';
import { StepInferenceProvider } from './StepInferenceProvider';
import { StepComputeProvider } from './StepComputeProvider';
import { StepComputeConfig } from './StepComputeConfig';
import { StepSourceControlProvider } from './StepSourceControlProvider';
import { StepSourceControlConfig } from './StepSourceControlConfig';
import { StepSourceControlConnect } from './StepSourceControlConnect';
import { StepCommunicationConnect } from './StepCommunicationConnect';
import { StepInvoke } from './StepInvoke';
import { useSetupFlow } from './hooks';
import { StepRepoSelection, type SetupRetryReason } from './StepRepoSelection';
import { getSetupStepPath } from './types';
import { LoadingSetupFlow, stepTransitionVariants } from './SetupBootstrapFlow';

function getSetupRetryReason(status: {
  onboardingFailed: boolean;
  onboardingTaskStatus: string | null;
  onboardingTaskPhase?: string | null;
  matchingEnvironment: { id: string; name: string } | null;
}): SetupRetryReason | null {
  if (!status.onboardingFailed) return null;
  if (
    (status.onboardingTaskStatus === 'completed' ||
      (status.onboardingTaskStatus === 'idle' &&
        status.onboardingTaskPhase === 'waiting_for_prompt')) &&
    status.matchingEnvironment === null
  )
    return 'no-environment';
  return status.onboardingTaskStatus === 'canceled'
    ? 'task-canceled'
    : 'task-failed';
}

export function SetupSignedInFlow() {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { authStatus, isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;
  const [pendingAuthProvider, setPendingAuthProvider] =
    useState<CommunicationProviderChoice | null>(null);
  const pendingSetupAuthProvider =
    pendingAuthProvider === 'telegram' || pendingAuthProvider === 'discord'
      ? null
      : pendingAuthProvider;
  const [pendingSourceControlProvider, setPendingSourceControlProvider] =
    useState<SourceControlProvider | null>(null);
  const [pendingComputeProvider, setPendingComputeProvider] =
    useState<ComputeProvider | null>(null);
  const [pendingModelProvider, setPendingModelProvider] =
    useState<SetupModelProviderId | null>(null);
  const trackWelcomeSeen = useMutation(
    trpc.setupNew.trackWelcomeSeen.mutationOptions(),
  );
  const {
    data: setupStatus,
    isLoading: isSetupStatusLoading,
    isError: isSetupStatusError,
  } = useQuery(
    trpc.setup.status.queryOptions(undefined, {
      enabled: isSignedIn && isAdmin,
      staleTime: 30_000,
    }),
  );
  const flow = useSetupFlow({
    enabled: isSignedIn && isAdmin,
    pendingAuthProvider: pendingSetupAuthProvider,
  });
  const {
    step,
    transitionDirection,
    entryContext,
    goToStep,
    goToPreviousStep,
    goToNextStep,
    canGoBack,
    goToNextPostOnboardingStep,
    readSetupSearchParams,
    commitSetupUrl,
    status,
    setupSession,
    isLoading,
    isError,
  } = flow;

  const saveSourceControlProviderChoice = useMutation(
    trpc.setupNew.saveSourceControlProviderChoice.mutationOptions({
      onSuccess: async (_data, variables) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        setPendingSourceControlProvider(variables.provider);
        goToStep('source-control-config');
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const saveAuthProviderChoice = useMutation(
    trpc.setupNew.saveAuthProviderChoice.mutationOptions({
      onSuccess: async (_data, variables) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        setPendingAuthProvider(variables.provider);
        goToStep('auth-env-vars');
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const saveComputeProviderChoice = useMutation(
    trpc.setupNew.saveComputeProviderChoice.mutationOptions({
      onSuccess: async (_data, variables) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        setPendingComputeProvider(variables.provider);
        const selectedProvider = status?.computeSetup.providers.find(
          (provider) => provider.provider === variables.provider,
        );
        if (
          selectedProvider &&
          !selectedProvider.fields.some(isComputeCredentialField)
        ) {
          goToNextStep();
          return;
        }
        goToStep('compute-config', { revisit: true });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const selectedComputeProvider =
    pendingComputeProvider ?? status?.setupNewState.computeProvider;
  const selectedAuthProvider =
    pendingAuthProvider ??
    status?.setupNewState.authProvider ??
    status?.authSetup.runtimeConfiguredProvider ??
    status?.authSetup.selectedProvider;
  const selectedSourceControlProvider =
    pendingSourceControlProvider ??
    status?.setupNewState.sourceControlProvider ??
    status?.sourceControlSetup.runtimeConfiguredProvider ??
    status?.sourceControlSetup.selectedProvider;
  const selectedModelProvider =
    pendingModelProvider ?? status?.setupNewState.modelProvider;

  useEffect(() => {
    const params = readSetupSearchParams();
    const providerParams = {
      authProvider: selectedAuthProvider,
      computeProvider: selectedComputeProvider,
      modelProvider: selectedModelProvider,
      sourceControlProvider: selectedSourceControlProvider,
    };
    let changed = false;
    for (const [key, value] of Object.entries(providerParams)) {
      if (value && params.get(key) !== value) {
        params.set(key, value);
        changed = true;
      } else if (!value && params.has(key)) {
        params.delete(key);
        changed = true;
      }
    }
    if (changed) commitSetupUrl(params);
  }, [
    commitSetupUrl,
    readSetupSearchParams,
    selectedAuthProvider,
    selectedComputeProvider,
    selectedModelProvider,
    selectedSourceControlProvider,
  ]);
  const shouldEvaluateSetupRedirect = isSignedIn && isAdmin;
  const setupRedirectPath =
    shouldEvaluateSetupRedirect && !isSetupStatusError && setupStatus != null
      ? getSetupRedirectPath(setupStatus)
      : null;
  const observedIncompleteSetupRef = useRef(false);

  useEffect(() => {
    if (setupStatus != null && setupStatus.setupCompletedAt == null)
      observedIncompleteSetupRef.current = true;
  }, [setupStatus]);
  useEffect(() => {
    if (authStatus === 'signed-in' && !isAdmin) {
      router.replace('/');
      return;
    }
    if (!shouldEvaluateSetupRedirect) return;
    if (!isSetupStatusLoading && !isSetupStatusError && setupStatus != null) {
      if (
        setupRedirectPath &&
        setupRedirectPath !== DEFAULT_SETUP_REDIRECT_PATH
      ) {
        router.replace(setupRedirectPath);
        return;
      }
      if (setupRedirectPath === null && !observedIncompleteSetupRef.current) {
        router.replace('/');
        return;
      }
    }
    if (isError) router.replace('/');
  }, [
    authStatus,
    isAdmin,
    isError,
    isSetupStatusError,
    isSetupStatusLoading,
    shouldEvaluateSetupRedirect,
    router,
    setupStatus,
    setupRedirectPath,
  ]);
  useEffect(() => {
    if (status?.setupNewState.authProvider) setPendingAuthProvider(null);
  }, [status?.setupNewState.authProvider]);
  useEffect(() => {
    if (status?.setupNewState.modelProvider) setPendingModelProvider(null);
  }, [status?.setupNewState.modelProvider]);

  if (!isSignedIn || !isAdmin) return null;
  if (isError)
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Unable to load setup. Redirecting you to Home.
        </p>
        <Button type="button" size="sm" onClick={() => router.replace('/')}>
          Go home
        </Button>
      </div>
    );
  if (isLoading || !status) return <LoadingSetupFlow />;

  const removeSourceControlSyncMarker = () => {
    const params = readSetupSearchParams();
    params.delete('sync');
    commitSetupUrl(params);
  };
  const setupRetryReason = getSetupRetryReason(status);
  const computeProvisioning =
    selectedComputeProvider &&
    isSetupProvisionableComputeProvider(selectedComputeProvider)
      ? getSetupNewComputeProvisioningState(
          status.setupNewState,
          selectedComputeProvider,
        )
      : null;
  const hasPersistedSelectedSuggestedTasks = status.queuedOnboardingTasks.some(
    (task) => task.suggestionId !== null,
  );

  return (
    <div className="relative w-full">
      <AnimatePresence mode="wait" initial={false} custom={transitionDirection}>
        <motion.div
          key={step}
          custom={transitionDirection}
          variants={stepTransitionVariants}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {step === 'welcome' && (
            <StepWelcome
              onContinue={() => {
                trackWelcomeSeen.mutate();
                goToNextStep();
              }}
            />
          )}
          {step === 'auth-provider' && (
            <StepAuthProvider
              additionalProviders={['telegram', 'discord']}
              onContinue={(provider) => {
                if (provider === 'telegram' || provider === 'discord') {
                  setPendingAuthProvider(provider);
                  goToStep('auth-env-vars');
                  return;
                }
                saveAuthProviderChoice.mutate({ provider });
              }}
              onSkip={() => {
                setupSession.setCommunicationStepState('skipped');
                goToNextStep();
              }}
              onBack={canGoBack ? goToPreviousStep : undefined}
              disabled={saveAuthProviderChoice.isPending}
            />
          )}
          {step === 'auth-env-vars' &&
            (pendingAuthProvider === 'telegram' ? (
              <StepTelegramSetup
                onContinue={() => {
                  setupSession.setCommunicationStepState('completed');
                  setPendingAuthProvider(null);
                  goToNextStep();
                }}
                onBack={
                  canGoBack
                    ? () => {
                        setPendingAuthProvider(null);
                        goToPreviousStep();
                      }
                    : undefined
                }
              />
            ) : pendingAuthProvider === 'discord' ? (
              <StepDiscordSetup
                onContinue={() => {
                  setupSession.setCommunicationStepState('completed');
                  setPendingAuthProvider(null);
                  goToNextStep();
                }}
                onBack={
                  canGoBack
                    ? () => {
                        setPendingAuthProvider(null);
                        goToPreviousStep();
                      }
                    : undefined
                }
              />
            ) : (
              <StepAuthEnvVars
                authSetup={status.authSetup}
                selectedProviderId={pendingAuthProvider}
                onContinue={() => {
                  setPendingAuthProvider(null);
                  goToNextStep();
                }}
                onBack={() => {
                  setPendingAuthProvider(null);
                  if (canGoBack) {
                    goToPreviousStep();
                    return;
                  }
                  goToStep('auth-provider');
                }}
                bootstrapMode={false}
              />
            ))}
          {step === 'env-vars' && (
            <StepInferenceProvider
              modelSetup={status.modelSetup}
              openRouterOauthStatus={entryContext.openrouterOauthStatus}
              openRouterOauthErrorReason={
                entryContext.openrouterOauthErrorReason
              }
              onContinue={() => {
                setPendingModelProvider(null);
                goToNextStep();
              }}
              onBack={canGoBack ? goToPreviousStep : undefined}
              onSelectedProviderChange={setPendingModelProvider}
            />
          )}
          {step === 'source-control-provider' && (
            <StepSourceControlProvider
              sourceControlSetup={status.sourceControlSetup}
              onContinue={(provider) =>
                saveSourceControlProviderChoice.mutate({ provider })
              }
              onBack={canGoBack ? goToPreviousStep : undefined}
              disabled={saveSourceControlProviderChoice.isPending}
            />
          )}
          {step === 'source-control-config' && (
            <StepSourceControlConfig
              sourceControlSetup={status.sourceControlSetup}
              selectedProviderId={pendingSourceControlProvider}
              onContinue={() => {
                setPendingSourceControlProvider(null);
                goToStep('source-control-connect');
              }}
              onBack={() => {
                setPendingSourceControlProvider(null);
                if (canGoBack) {
                  goToPreviousStep();
                  return;
                }
                goToStep('source-control-provider');
              }}
            />
          )}
          {step === 'source-control-connect' && (
            <StepSourceControlConnect
              sourceControlSetup={status.sourceControlSetup}
              onContinue={goToNextStep}
              onRemoveSyncMarker={removeSourceControlSyncMarker}
              onBack={canGoBack ? goToPreviousStep : undefined}
            />
          )}
          {step === 'compute-provider' && (
            <StepComputeProvider
              computeSetup={status.computeSetup}
              onContinue={(provider) =>
                saveComputeProviderChoice.mutate({ provider })
              }
              onBack={canGoBack ? goToPreviousStep : undefined}
              disabled={saveComputeProviderChoice.isPending}
            />
          )}
          {step === 'compute-config' && (
            <StepComputeConfig
              computeSetup={status.computeSetup}
              selectedProviderId={pendingComputeProvider}
              onContinue={() => {
                setPendingComputeProvider(null);
                goToNextStep();
              }}
              onBack={
                canGoBack
                  ? () => {
                      setPendingComputeProvider(null);
                      goToPreviousStep();
                    }
                  : undefined
              }
            />
          )}
          {step === 'slack' && (
            <StepCommunicationConnect
              authSetup={status.authSetup}
              onContinue={goToNextStep}
              onSkip={() => {
                setupSession.setCommunicationStepState('skipped');
                goToNextStep();
              }}
              onBack={canGoBack ? goToPreviousStep : undefined}
              returnPath={getSetupStepPath('slack')}
            />
          )}
          {step === 'repo-selection' && (
            <StepRepoSelection
              initialSelectedRepositoryIds={
                status.setupNewState.selectedRepositoryIds
              }
              initialSetupGuidance={status.setupNewState.setupGuidance ?? ''}
              initialSelectedModelId={status.setupNewState.selectedModelId}
              retryReason={setupRetryReason}
              computeProvisioningError={
                computeProvisioning?.status === 'failed'
                  ? computeProvisioning.error
                  : null
              }
              onRetryComputeProvisioning={() =>
                goToStep('compute-config', { revisit: true })
              }
              onReviewComputeProvider={() =>
                goToStep('compute-provider', { revisit: true })
              }
              onContinue={() => goToStep('invoke')}
              onBack={canGoBack ? goToPreviousStep : undefined}
              onSkip={() => {
                setupSession.unlockPostOnboardingFlow();
                goToNextPostOnboardingStep(true);
              }}
            />
          )}
          {step === 'invoke' && (
            <StepInvoke
              onboardingTaskId={status.setupNewState.onboardingTaskId}
              communicationProviders={
                status.authSetup.selectedProvider
                  ? [status.authSetup.selectedProvider]
                  : status.hasSlack
                    ? ['slack']
                    : []
              }
              sourceControlProviders={
                status.sourceControlSetup.connectedProvider
                  ? [status.sourceControlSetup.connectedProvider]
                  : status.sourceControlSetup.selectedProvider
                    ? [status.sourceControlSetup.selectedProvider]
                    : status.hasGitHub
                      ? ['github']
                      : []
              }
              includeLinear={status.hasLinear}
              linkSuggestedTasks={hasPersistedSelectedSuggestedTasks}
              computeProvisioning={computeProvisioning}
              onRetryComputeProvisioning={() =>
                goToStep('compute-config', { revisit: true })
              }
              onTryItOut={() => undefined}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

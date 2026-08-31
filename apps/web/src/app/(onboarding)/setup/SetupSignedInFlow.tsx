'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  getSetupNewComputeProvisioningState,
  isSetupProvisionableComputeProvider,
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
import { StepInferenceProvider } from './StepInferenceProvider';
import { StepConfigureInference } from './StepConfigureInference';
import { StepSourceControlProvider } from './StepSourceControlProvider';
import { StepSourceControlConfig } from './StepSourceControlConfig';
import { StepSourceControlConnect } from './StepSourceControlConnect';
import { useSetupFlow } from './hooks';
import { StepInvoke } from './StepInvoke';
import { LoadingSetupFlow, stepTransitionVariants } from './SetupBootstrapFlow';

export function SetupSignedInFlow() {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { authStatus, isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;
  const [pendingSourceControlProvider, setPendingSourceControlProvider] =
    useState<SourceControlProvider | null>(null);
  const [pendingModelProvider, setPendingModelProvider] =
    useState<SetupModelProviderId | null>(null);
  const trackWelcomeSeen = useMutation(
    trpc.setupNew.trackWelcomeSeen.mutationOptions(),
  );
  const {
    data: setupSession,
    isPending: isSetupSessionPending,
    isError: isSetupSessionError,
    mutate: createSetupSession,
  } = useMutation(
    trpc.setup.getOrCreateSession.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
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
  });
  const {
    step,
    transitionDirection,
    entryContext,
    goToStep,
    goToPreviousStep,
    goToNextStep,
    canGoBack,
    readSetupSearchParams,
    commitSetupUrl,
    status,
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
    if (status?.setupNewState.modelProvider) setPendingModelProvider(null);
  }, [status?.setupNewState.modelProvider]);

  const conversationalSetupReady =
    status != null &&
    status.modelSetup.setupSatisfied &&
    status.setupCompletedAt == null;
  const setupSessionId = setupSession?.sessionId ?? null;

  useEffect(() => {
    if (!conversationalSetupReady) return;

    if (setupSessionId) {
      router.replace(`/sessions/${setupSessionId}`);
      return;
    }

    if (!isSetupSessionPending && !isSetupSessionError) {
      createSetupSession();
    }
  }, [
    conversationalSetupReady,
    createSetupSession,
    isSetupSessionError,
    isSetupSessionPending,
    router,
    setupSessionId,
  ]);

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

  const legacySetupStarted =
    status.setupNewState.onboardingTaskId !== null &&
    status.setupNewState.onboardingTaskStartedAt !== null;
  if (legacySetupStarted) {
    const provider = status.setupNewState.computeProvider;
    const computeProvisioning =
      provider && isSetupProvisionableComputeProvider(provider)
        ? getSetupNewComputeProvisioningState(status.setupNewState, provider)
        : null;
    return (
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
            : []
        }
        includeLinear={status.hasLinear}
        linkSuggestedTasks={status.queuedOnboardingTasks.some(
          (task) => task.suggestionId !== null,
        )}
        computeProvisioning={computeProvisioning}
        onRetryComputeProvisioning={() => undefined}
        onTryItOut={() => undefined}
      />
    );
  }

  if (conversationalSetupReady) {
    return <LoadingSetupFlow />;
  }

  const removeSourceControlSyncMarker = () => {
    const params = readSetupSearchParams();
    params.delete('sync');
    commitSetupUrl(params);
  };

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
          {step === 'inference' && (
            <StepConfigureInference
              onUseTrial={goToNextStep}
              onConfigureProvider={() =>
                goToStep('env-vars', { revisit: true })
              }
              onBack={canGoBack ? goToPreviousStep : undefined}
            />
          )}
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
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

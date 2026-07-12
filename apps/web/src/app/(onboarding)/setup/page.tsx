'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  isComputeCredentialField,
  type ComputeProvider,
  type SetupAuthProviderId,
  type SourceControlProvider,
} from '@roomote/types';

import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useSetupBootstrapOpen, useUser } from '@/hooks/useUser';
import {
  INVITE_COOKIE_NAME,
  readInviteTokenFromDocumentCookie,
} from '@/lib/invite-cookie';
import {
  DEFAULT_SETUP_REDIRECT_PATH,
  getSetupRedirectPath,
} from '@/lib/setup-status';
import { useTRPC } from '@/trpc/client';
import { Button, Spinner } from '@/components/system';

import { StepWelcome } from './StepWelcome';
import { StepAuthEnvVars } from './StepAuthEnvVars';
import { StepBootstrapAccount } from './StepBootstrapAccount';
import { StepBootstrapEmailPassword } from './StepBootstrapEmailPassword';
import { StepSetupToken } from './StepSetupToken';
import { StepAuthProvider } from './StepAuthProvider';
import { StepInferenceProvider } from './StepInferenceProvider';
import { StepComputeProvider } from './StepComputeProvider';
import { StepComputeConfig } from './StepComputeConfig';
import { StepSourceControlProvider } from './StepSourceControlProvider';
import { StepSourceControlConfig } from './StepSourceControlConfig';
import { StepSourceControlConnect } from './StepSourceControlConnect';
import { StepQualificationBlocked } from './StepQualificationBlocked';
import { StepCommunicationConnect } from './StepCommunicationConnect';
import { StepInvoke } from './StepInvoke';
import { useSetupFlow } from './hooks';
import { StepRepoSelection, type SetupRetryReason } from './StepRepoSelection';
import { StepOnboardingAgent } from './StepOnboardingAgent';
import { getSetupStepPath } from './types';
import {
  getBootstrapAuthProvider,
  getBootstrapStepFromSetupStepParam,
  getBootstrapStepAfterWelcome,
  getNextBootstrapStep,
  type BootstrapStep,
} from './bootstrapFlow';

function getSetupRetryReason(status: {
  onboardingFailed: boolean;
  onboardingTaskStatus: string | null;
  onboardingTaskPhase?: string | null;
  matchingEnvironment: { id: string; name: string } | null;
}): SetupRetryReason | null {
  if (!status.onboardingFailed) {
    return null;
  }

  if (
    (status.onboardingTaskStatus === 'completed' ||
      (status.onboardingTaskStatus === 'idle' &&
        status.onboardingTaskPhase === 'waiting_for_prompt')) &&
    status.matchingEnvironment === null
  ) {
    return 'no-environment';
  }

  if (status.onboardingTaskStatus === 'canceled') {
    return 'task-canceled';
  }

  return 'task-failed';
}

function getInitialBootstrapStep(): BootstrapStep {
  if (typeof window === 'undefined') {
    return 'welcome';
  }

  return (
    getBootstrapStepFromSetupStepParam(
      new URLSearchParams(window.location.search).get('step'),
    ) ?? 'welcome'
  );
}

export default function SetupPage() {
  const router = useRouter();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const { authStatus, isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;
  const shouldRedirectToSignIn =
    authStatus === 'signed-out' && !setupBootstrapOpen;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [bootstrapStep, setBootstrapStep] = useState<BootstrapStep>(
    getInitialBootstrapStep,
  );
  const [pendingAuthProvider, setPendingAuthProvider] =
    useState<SetupAuthProviderId | null>(null);
  const [pendingSourceControlProvider, setPendingSourceControlProvider] =
    useState<SourceControlProvider | null>(null);
  const [pendingComputeProvider, setPendingComputeProvider] =
    useState<ComputeProvider | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    // OAuth sign-in round-trips return to /setup without the ?token= query
    // param, so fall back to the invite cookie to avoid bouncing the visitor
    // back to the setup-token gate mid-flow.
    return (
      new URLSearchParams(window.location.search).get('token') ??
      readInviteTokenFromDocumentCookie()
    );
  });
  const { data: bootstrapStatus, isLoading: isBootstrapLoading } = useQuery(
    trpc.setupBootstrap.status.queryOptions(
      setupToken ? { setupToken } : undefined,
      {
        enabled: !isSignedIn && setupBootstrapOpen,
        staleTime: 5_000,
      },
    ),
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
  const {
    step,
    entryContext,
    goToStep,
    goToNextStep,
    goToNextPostOnboardingStep,
    status,
    setupSession,
    isLoading,
    isError,
  } = useSetupFlow({
    enabled: isSignedIn && isAdmin,
    pendingAuthProvider,
  });
  const saveSourceControlProviderChoice = useMutation(
    trpc.setupNew.saveSourceControlProviderChoice.mutationOptions({
      onSuccess: async (_data, variables) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        setPendingSourceControlProvider(variables.provider);
        goToStep('source-control-config');
      },
      onError: (error) => {
        toast.error(error.message);
      },
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

        // Credentialless providers stay on the short path even when they
        // expose optional advanced settings later in Settings.
        if (
          selectedProvider &&
          !selectedProvider.fields.some(isComputeCredentialField)
        ) {
          goToNextStep();
          return;
        }

        // Pin the config step so already-satisfied credentials stay
        // reviewable/editable instead of auto-skipping past them.
        goToStep('compute-config', { revisit: true });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const hasPersistedSelectedSuggestedTasks = (
    status?.queuedOnboardingTasks ?? []
  ).some((task) => task.suggestionId !== null);
  const bootstrapAuthProvider = getBootstrapAuthProvider(
    bootstrapStatus?.authSetup,
    pendingAuthProvider,
  );
  const setupRetryReason = status ? getSetupRetryReason(status) : null;
  const shouldEvaluateSetupRedirect = isSignedIn && isAdmin;
  const setupRedirectPath =
    shouldEvaluateSetupRedirect && !isSetupStatusError && setupStatus != null
      ? getSetupRedirectPath(setupStatus)
      : null;
  useRedirectToSignIn(shouldRedirectToSignIn);

  useEffect(() => {
    if (authStatus === 'signed-in' && !isAdmin) {
      router.replace('/');
      return;
    }

    if (!shouldEvaluateSetupRedirect) {
      return;
    }

    if (!isSetupStatusLoading && !isSetupStatusError && setupStatus != null) {
      if (
        setupRedirectPath &&
        setupRedirectPath !== DEFAULT_SETUP_REDIRECT_PATH
      ) {
        router.replace(setupRedirectPath);
        return;
      }

      if (setupRedirectPath === null) {
        router.replace('/');
        return;
      }
    }

    if (isError) {
      router.replace('/');
    }
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
    if (isSignedIn || !bootstrapStatus) {
      return;
    }

    if (!bootstrapStatus.setupOpen) {
      router.replace('/sign-in');
      return;
    }

    setBootstrapStep((currentStep) => {
      if (currentStep === 'welcome') {
        return currentStep;
      }

      if (currentStep === 'email-account' || currentStep === 'email-password') {
        const nextBootstrapStep = getBootstrapStepAfterWelcome(
          bootstrapStatus.authSetup,
        );
        return nextBootstrapStep === 'email-account'
          ? currentStep
          : nextBootstrapStep;
      }

      return getNextBootstrapStep(
        bootstrapStatus.authSetup,
        pendingAuthProvider,
      );
    });
  }, [bootstrapStatus, isSignedIn, pendingAuthProvider, router]);

  useEffect(() => {
    if (status?.setupNewState.authProvider) {
      setPendingAuthProvider(null);
    }
  }, [status?.setupNewState.authProvider]);

  useEffect(() => {
    // The setup token doubles as the system invite for the first admin
    // account, so it has to reach the sign-up request as the invite cookie.
    // Only persist it once the server confirms it, so a stale or mistyped
    // ?token= can never clobber a still-valid cookie.
    if (!isSignedIn && setupToken && bootstrapStatus?.setupTokenSatisfied) {
      document.cookie = `${INVITE_COOKIE_NAME}=${encodeURIComponent(setupToken)}; path=/; max-age=3600; SameSite=Lax`;
    }
  }, [bootstrapStatus?.setupTokenSatisfied, isSignedIn, setupToken]);

  if (!isSignedIn) {
    if (isBootstrapLoading || !bootstrapStatus?.setupOpen) {
      return (
        <div className="flex h-full w-full items-center justify-center">
          <Spinner />
        </div>
      );
    }

    if (
      (bootstrapStatus.setupTokenRequired &&
        !bootstrapStatus.setupTokenSatisfied) ||
      bootstrapStatus.authSetup == null
    ) {
      return (
        <div className="relative w-full">
          <StepSetupToken
            hasRejectedToken={setupToken != null}
            onContinue={(nextSetupToken) => setSetupToken(nextSetupToken)}
          />
        </div>
      );
    }

    return (
      <div className="relative w-full">
        {bootstrapStep === 'welcome' && (
          <StepWelcome
            onContinue={() => {
              setBootstrapStep(
                getBootstrapStepAfterWelcome(bootstrapStatus.authSetup),
              );
            }}
          />
        )}
        {bootstrapStep === 'email-account' && (
          <StepBootstrapAccount
            onUseProviderSignIn={(provider) => {
              setPendingAuthProvider(provider);
              setBootstrapStep(
                getNextBootstrapStep(bootstrapStatus.authSetup, provider),
              );
            }}
            onUseEmailPassword={() => setBootstrapStep('email-password')}
          />
        )}
        {bootstrapStep === 'email-password' && (
          <StepBootstrapEmailPassword
            onBack={() => setBootstrapStep('email-account')}
          />
        )}
        {bootstrapStep === 'auth-provider' && (
          <StepAuthProvider
            onContinue={(provider) => {
              setPendingAuthProvider(provider);
              setBootstrapStep('auth-env-vars');
            }}
            onBack={() => setBootstrapStep('email-account')}
          />
        )}
        {bootstrapStep === 'auth-env-vars' && (
          <StepAuthEnvVars
            authSetup={bootstrapStatus.authSetup}
            selectedProviderId={bootstrapAuthProvider}
            onContinue={() => undefined}
            onBack={() => setBootstrapStep('email-account')}
            bootstrapMode={true}
            setupToken={setupToken}
          />
        )}
      </div>
    );
  }

  if (!isSignedIn || !isAdmin) {
    return null;
  }

  if (isError) {
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
  }

  if (isLoading || !status) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {step === 'welcome' && <StepWelcome onContinue={goToNextStep} />}
      {step === 'auth-provider' && (
        <StepAuthProvider
          onContinue={(provider) => {
            setPendingAuthProvider(provider);
            goToStep('auth-env-vars');
          }}
          onSkip={() => {
            setupSession.setCommunicationStepState('skipped');
            goToNextStep();
          }}
        />
      )}
      {step === 'auth-env-vars' && (
        <StepAuthEnvVars
          authSetup={status.authSetup}
          selectedProviderId={pendingAuthProvider}
          onContinue={() => {
            setPendingAuthProvider(null);
            goToNextStep();
          }}
          onBack={() => goToStep('auth-provider')}
          bootstrapMode={false}
        />
      )}
      {step === 'env-vars' && (
        <StepInferenceProvider
          modelSetup={status.modelSetup}
          openRouterOauthStatus={entryContext.openrouterOauthStatus}
          openRouterOauthErrorReason={entryContext.openrouterOauthErrorReason}
          onContinue={goToNextStep}
        />
      )}
      {step === 'source-control-provider' && (
        <StepSourceControlProvider
          sourceControlSetup={status.sourceControlSetup}
          onContinue={(provider) => {
            saveSourceControlProviderChoice.mutate({ provider });
          }}
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
          onBack={() => goToStep('source-control-provider')}
        />
      )}
      {step === 'source-control-connect' && (
        <StepSourceControlConnect
          sourceControlSetup={status.sourceControlSetup}
          onContinue={goToNextStep}
        />
      )}
      {step === 'qualification-blocked' &&
      status.setupQualification.activeBlock ? (
        <StepQualificationBlocked />
      ) : null}
      {step === 'compute-provider' && (
        <StepComputeProvider
          computeSetup={status.computeSetup}
          onContinue={(provider) => {
            saveComputeProviderChoice.mutate({ provider });
          }}
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
          onBack={() => goToStep('compute-provider')}
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
          onReviewComputeProvider={() =>
            goToStep('compute-provider', { revisit: true })
          }
          onContinue={() => goToStep('onboarding-agent')}
          onSkip={() => {
            setupSession.unlockPostOnboardingFlow();
            goToNextPostOnboardingStep(true);
          }}
        />
      )}
      {step === 'onboarding-agent' && (
        <StepOnboardingAgent
          selectedRepositories={status.selectedRepositories}
          onboardingTaskId={status.setupNewState.onboardingTaskId}
          onboardingTaskStartedAt={status.setupNewState.onboardingTaskStartedAt}
          slackChannel={status.setupNewState.slackChannel}
          slackThreadTs={status.setupNewState.slackThreadTs}
          chatHandoffProvider={status.setupNewState.chatHandoffProvider}
          onboardingFinished={status.onboardingSucceeded}
          onContinue={() => {
            setupSession.unlockPostOnboardingFlow();
            goToNextPostOnboardingStep(true);
          }}
          onDoLater={() => {
            setupSession.unlockPostOnboardingFlow();
            goToNextPostOnboardingStep(true);
          }}
          onReturnToSelection={() => goToStep('repo-selection')}
          onStartFailure={() => undefined}
          onTaskStarted={() => undefined}
        />
      )}
      {step === 'invoke' && (
        <StepInvoke
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
          onTryItOut={() => undefined}
        />
      )}
    </div>
  );
}

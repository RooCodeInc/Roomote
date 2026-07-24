'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
import { useSetSetupDocsContent } from './SetupDocsContext';
import {
  getBootstrapAuthProvider,
  getBootstrapStepPath,
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

const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  'welcome',
  'email-account',
  'email-password',
  'auth-provider',
  'auth-env-vars',
];

export default function SetupPageClient({
  setupDocsContent,
}: {
  setupDocsContent: ReactNode;
}) {
  const router = useRouter();
  const setSetupDocsContent = useSetSetupDocsContent();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const { authStatus, isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;

  useEffect(() => {
    setSetupDocsContent(setupDocsContent);
  }, [setSetupDocsContent, setupDocsContent]);
  const shouldRedirectToSignIn =
    authStatus === 'signed-out' && !setupBootstrapOpen;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [bootstrapStep, setBootstrapStep] = useState<BootstrapStep>(
    getInitialBootstrapStep,
  );
  const [bootstrapTransitionDirection, setBootstrapTransitionDirection] =
    useState<'forward' | 'backward'>('forward');
  const bootstrapStepRef = useRef(bootstrapStep);
  bootstrapStepRef.current = bootstrapStep;
  const setBootstrapStepWithTransition = useCallback(
    (nextStep: BootstrapStep) => {
      const currentIndex = BOOTSTRAP_STEPS.indexOf(bootstrapStepRef.current);
      const nextIndex = BOOTSTRAP_STEPS.indexOf(nextStep);

      if (nextStep !== bootstrapStepRef.current) {
        setBootstrapTransitionDirection(
          nextIndex >= currentIndex ? 'forward' : 'backward',
        );
      }

      bootstrapStepRef.current = nextStep;
      setBootstrapStep(nextStep);
      router.replace(
        getBootstrapStepPath(
          nextStep,
          new URLSearchParams(window.location.search),
        ),
      );
    },
    [router],
  );
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
    transitionDirection,
    entryContext,
    goToStep,
    goToPreviousStep,
    goToNextStep,
    canGoBack,
    goToNextPostOnboardingStep,
    status,
    setupSession,
    isLoading,
    isError,
  } = useSetupFlow({
    enabled: isSignedIn && isAdmin,
    pendingAuthProvider: pendingSetupAuthProvider,
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
  const saveAuthProviderChoice = useMutation(
    trpc.setupNew.saveAuthProviderChoice.mutationOptions({
      onSuccess: async (_data, variables) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        // Only expose the choice as pending once the save has succeeded, so a
        // failed request can never prematurely skip the chooser with an
        // unsaved selection.
        setPendingAuthProvider(variables.provider);
        goToStep('auth-env-vars');
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
    pendingSetupAuthProvider,
  );
  const setupRetryReason = status ? getSetupRetryReason(status) : null;
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
    const params = new URLSearchParams(window.location.search);
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

    if (changed) {
      router.replace(`${window.location.pathname}?${params}`);
    }
  }, [
    router,
    selectedAuthProvider,
    selectedComputeProvider,
    selectedModelProvider,
    selectedSourceControlProvider,
  ]);
  const computeProvisioning =
    status &&
    selectedComputeProvider &&
    isSetupProvisionableComputeProvider(selectedComputeProvider)
      ? getSetupNewComputeProvisioningState(
          status.setupNewState,
          selectedComputeProvider,
        )
      : null;
  const shouldEvaluateSetupRedirect = isSignedIn && isAdmin;
  const setupRedirectPath =
    shouldEvaluateSetupRedirect && !isSetupStatusError && setupStatus != null
      ? getSetupRedirectPath(setupStatus)
      : null;
  // When the user finishes setup from the invoke step, setup.status flips to
  // completed before StepInvoke navigates to the onboarding task. Without this
  // guard the effect below would replace('/') first and flash Home.
  const observedIncompleteSetupRef = useRef(false);
  useRedirectToSignIn(shouldRedirectToSignIn);

  useEffect(() => {
    if (setupStatus != null && setupStatus.setupCompletedAt == null) {
      observedIncompleteSetupRef.current = true;
    }
  }, [setupStatus]);

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

      if (setupRedirectPath === null && !observedIncompleteSetupRef.current) {
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

    const currentStep = bootstrapStepRef.current;
    let nextStep = currentStep;

    if (currentStep !== 'welcome') {
      if (currentStep === 'email-account' || currentStep === 'email-password') {
        const nextBootstrapStep = getBootstrapStepAfterWelcome(
          bootstrapStatus.authSetup,
        );
        nextStep =
          nextBootstrapStep === 'email-account'
            ? currentStep
            : nextBootstrapStep;
      } else {
        nextStep = getNextBootstrapStep(
          bootstrapStatus.authSetup,
          pendingSetupAuthProvider,
        );
      }
    }

    if (nextStep !== currentStep) {
      setBootstrapStepWithTransition(nextStep);
    }
  }, [
    bootstrapStatus,
    isSignedIn,
    pendingSetupAuthProvider,
    router,
    setBootstrapStepWithTransition,
  ]);

  useEffect(() => {
    if (status?.setupNewState.authProvider) {
      setPendingAuthProvider(null);
    }
  }, [status?.setupNewState.authProvider]);

  useEffect(() => {
    if (status?.setupNewState.modelProvider) {
      setPendingModelProvider(null);
    }
  }, [status?.setupNewState.modelProvider]);

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
        <AnimatePresence
          mode="wait"
          initial={false}
          custom={bootstrapTransitionDirection}
        >
          <motion.div
            key={bootstrapStep}
            custom={bootstrapTransitionDirection}
            variants={{
              enter: (direction) => ({
                opacity: 0,
                y: direction === 'forward' ? 20 : -20,
              }),
              center: {
                opacity: 1,
                y: 0,
                transition: { duration: 0.25, ease: 'easeOut' },
              },
              exit: (direction) => ({
                opacity: 0,
                y: direction === 'forward' ? -20 : 20,
                transition: { duration: 0.25, ease: 'easeOut' },
              }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {bootstrapStep === 'welcome' && (
              <StepWelcome
                onContinue={() => {
                  setBootstrapStepWithTransition(
                    getBootstrapStepAfterWelcome(bootstrapStatus.authSetup),
                  );
                }}
              />
            )}
            {bootstrapStep === 'email-account' && (
              <StepBootstrapAccount
                onUseProviderSignIn={(provider) => {
                  setPendingAuthProvider(provider);
                  setBootstrapStepWithTransition(
                    getNextBootstrapStep(bootstrapStatus.authSetup, provider),
                  );
                }}
                onUseEmailPassword={() =>
                  setBootstrapStepWithTransition('email-password')
                }
              />
            )}
            {bootstrapStep === 'email-password' && (
              <StepBootstrapEmailPassword
                onBack={() => setBootstrapStepWithTransition('email-account')}
              />
            )}
            {bootstrapStep === 'auth-provider' && (
              <StepAuthProvider
                onContinue={(provider) => {
                  if (provider === 'telegram' || provider === 'discord') {
                    return;
                  }
                  setPendingAuthProvider(provider);
                  setBootstrapStepWithTransition('auth-env-vars');
                }}
                onBack={() => setBootstrapStepWithTransition('email-account')}
              />
            )}
            {bootstrapStep === 'auth-env-vars' && (
              <StepAuthEnvVars
                authSetup={bootstrapStatus.authSetup}
                selectedProviderId={bootstrapAuthProvider}
                onContinue={() => undefined}
                onBack={() => setBootstrapStepWithTransition('auth-provider')}
                bootstrapMode={true}
                setupToken={setupToken}
              />
            )}
          </motion.div>
        </AnimatePresence>
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
      <AnimatePresence mode="wait" initial={false} custom={transitionDirection}>
        <motion.div
          key={step}
          custom={transitionDirection}
          variants={{
            enter: (direction) => ({
              opacity: 0,
              y: direction === 'forward' ? 20 : -20,
            }),
            center: {
              opacity: 1,
              y: 0,
              transition: { duration: 0.25, ease: 'easeOut' },
            },
            exit: (direction) => ({
              opacity: 0,
              y: direction === 'forward' ? -20 : 20,
              transition: { duration: 0.25, ease: 'easeOut' },
            }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {step === 'welcome' && <StepWelcome onContinue={goToNextStep} />}
          {step === 'auth-provider' && (
            <StepAuthProvider
              additionalProviders={['telegram', 'discord']}
              onContinue={(provider) => {
                // Telegram and Discord are UI-only choices with no persisted
                // auth provider and their own setup steps, so keep them on
                // the pending-only path.
                if (provider === 'telegram' || provider === 'discord') {
                  setPendingAuthProvider(provider);
                  goToStep('auth-env-vars');
                  return;
                }

                // Persist the chosen provider first; the choice only becomes
                // pending and navigates on a successful save, so it survives a
                // reload and a failed save never skips the chooser with an
                // unsaved selection.
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
              onContinue={(provider) => {
                saveSourceControlProviderChoice.mutate({ provider });
              }}
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
              onBack={canGoBack ? goToPreviousStep : undefined}
            />
          )}
          {step === 'compute-provider' && (
            <StepComputeProvider
              computeSetup={status.computeSetup}
              onContinue={(provider) => {
                saveComputeProviderChoice.mutate({ provider });
              }}
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

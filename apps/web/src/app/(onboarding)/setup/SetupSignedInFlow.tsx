'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { SetupModelProviderId } from '@roomote/types';

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
import { useSetupFlow } from './hooks';
import { LoadingSetupFlow, stepTransitionVariants } from './SetupBootstrapFlow';

/**
 * Signed-in bootstrap for the conversational setup session.
 *
 * This page intentionally stops once inference is usable. Repository access,
 * starter work, sandbox configuration, and recommended automations belong to
 * the setup conversation itself.
 */
export function SetupSignedInFlow() {
  const router = useRouter();
  const trpc = useTRPC();
  const { authStatus, isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;
  const [pendingModelProvider, setPendingModelProvider] =
    useState<SetupModelProviderId | null>(null);
  const trackWelcomeSeen = useMutation(
    trpc.setupNew.trackWelcomeSeen.mutationOptions(),
  );
  const createSession = useMutation(
    trpc.setup.getOrCreateSession.mutationOptions({
      onSuccess: ({ sessionId }) => router.replace(`/sessions/${sessionId}`),
      onError: (error) => toast.error(error.message),
    }),
  );
  const setupStatus = useQuery(
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
    readSetupSearchParams,
    commitSetupUrl,
    status,
    isLoading,
    isError,
  } = useSetupFlow({ enabled: isSignedIn && isAdmin });

  const selectedModelProvider =
    pendingModelProvider ?? status?.setupNewState.modelProvider;

  useEffect(() => {
    const params = readSetupSearchParams();
    if (selectedModelProvider) {
      if (params.get('modelProvider') === selectedModelProvider) return;
      params.set('modelProvider', selectedModelProvider);
    } else {
      if (!params.has('modelProvider')) return;
      params.delete('modelProvider');
    }
    commitSetupUrl(params);
  }, [commitSetupUrl, readSetupSearchParams, selectedModelProvider]);

  const shouldEvaluateSetupRedirect = isSignedIn && isAdmin;
  const setupRedirectPath =
    shouldEvaluateSetupRedirect &&
    !setupStatus.isError &&
    setupStatus.data != null
      ? getSetupRedirectPath(setupStatus.data)
      : null;
  // Setup is complete once the setup Session records it. This page only
  // bootstraps inference for a fresh deployment, so a completed deployment
  // (for example an admin reopening the Cloud "open your deployment" link)
  // has nothing left to show here.
  const setupAlreadyCompleted =
    shouldEvaluateSetupRedirect &&
    !setupStatus.isError &&
    setupStatus.data?.setupCompletedAt != null;

  useEffect(() => {
    if (authStatus === 'signed-in' && !isAdmin) {
      router.replace('/');
      return;
    }
    if (!shouldEvaluateSetupRedirect) return;
    if (!setupStatus.isLoading && !setupStatus.isError && setupStatus.data) {
      if (
        setupRedirectPath &&
        setupRedirectPath !== DEFAULT_SETUP_REDIRECT_PATH
      ) {
        router.replace(setupRedirectPath);
        return;
      }
      // Leave the hand-off to the setup Session alone when it is in flight;
      // otherwise a completed deployment goes Home.
      if (
        setupRedirectPath === null &&
        !createSession.isPending &&
        !createSession.data
      ) {
        router.replace('/');
      }
    }
    if (isError) router.replace('/');
  }, [
    createSession.data,
    createSession.isPending,
    authStatus,
    isAdmin,
    isError,
    router,
    setupRedirectPath,
    setupStatus.data,
    setupStatus.isError,
    setupStatus.isLoading,
    shouldEvaluateSetupRedirect,
  ]);

  useEffect(() => {
    if (status?.setupNewState.modelProvider) setPendingModelProvider(null);
  }, [status?.setupNewState.modelProvider]);

  const conversationalSetupReady =
    status?.modelSetup.setupSatisfied === true &&
    status.setupCompletedAt == null;

  useEffect(() => {
    if (
      conversationalSetupReady &&
      !createSession.isPending &&
      !createSession.isError &&
      !createSession.data
    ) {
      createSession.mutate();
    }
  }, [conversationalSetupReady, createSession]);

  if (!isSignedIn || !isAdmin) return null;
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
  if (isLoading || !status) return <LoadingSetupFlow />;
  // Hold the spinner instead of flashing the inference prompts while the
  // completion check is in flight or the redirect Home is pending.
  if (
    shouldEvaluateSetupRedirect &&
    (setupStatus.isLoading || setupAlreadyCompleted)
  ) {
    return <LoadingSetupFlow />;
  }

  if (conversationalSetupReady) {
    if (createSession.isError) {
      return (
        <div className="mx-auto max-w-md space-y-4 text-center">
          <p className="font-semibold">I couldn’t start the setup session.</p>
          <p className="text-sm text-muted-foreground">
            {createSession.error.message}
          </p>
          <Button type="button" onClick={() => createSession.mutate()}>
            Try again
          </Button>
        </div>
      );
    }
    return <LoadingSetupFlow />;
  }

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
          {step === 'welcome' ? (
            <StepWelcome
              onContinue={() => {
                trackWelcomeSeen.mutate();
                goToNextStep();
              }}
            />
          ) : step === 'inference' ? (
            <StepConfigureInference
              onUseTrial={goToNextStep}
              onConfigureProvider={() =>
                goToStep('env-vars', { revisit: true })
              }
              onBack={canGoBack ? goToPreviousStep : undefined}
            />
          ) : (
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
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

'use client';

import { AnimatePresence, motion, type Variants } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useSetupBootstrapOpen, useUser } from '@/hooks/useUser';
import {
  INVITE_COOKIE_NAME,
  readInviteTokenFromDocumentCookie,
} from '@/lib/invite-cookie';
import { Spinner } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { StepWelcome } from './StepWelcome';
import { StepAuthEnvVars } from './StepAuthEnvVars';
import { StepBootstrapAccount } from './StepBootstrapAccount';
import { StepBootstrapEmailPassword } from './StepBootstrapEmailPassword';
import { StepSetupToken } from './StepSetupToken';
import {
  StepAuthProvider,
  type CommunicationProviderChoice,
} from './StepAuthProvider';
import {
  getBootstrapAuthProvider,
  getBootstrapStepFromSetupStepParam,
  getBootstrapStepAfterWelcome,
  getNextBootstrapStep,
  type BootstrapAuthConfigEntryStep,
  type BootstrapStep,
} from './bootstrapFlow';
import { useSetupFlow } from './hooks';

const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  'welcome',
  'email-account',
  'email-password',
  'auth-provider',
  'auth-env-vars',
];

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

export function SetupBootstrapFlow() {
  const router = useRouter();
  const trpc = useTRPC();
  const { authStatus, isSignedIn } = useUser();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const shouldRedirectToSignIn =
    authStatus === 'signed-out' && !setupBootstrapOpen;
  const { readSetupSearchParams, commitSetupUrl } = useSetupFlow({
    enabled: false,
  });
  const [bootstrapStep, setBootstrapStep] = useState<BootstrapStep>(
    getInitialBootstrapStep,
  );
  const [bootstrapTransitionDirection, setBootstrapTransitionDirection] =
    useState<'forward' | 'backward'>('forward');
  const bootstrapStepRef = useRef(bootstrapStep);
  bootstrapStepRef.current = bootstrapStep;
  const [pendingAuthProvider, setPendingAuthProvider] =
    useState<CommunicationProviderChoice | null>(null);
  const [authConfigEntryStep, setAuthConfigEntryStep] =
    useState<BootstrapAuthConfigEntryStep>('auth-provider');
  const pendingSetupAuthProvider =
    pendingAuthProvider === 'telegram' || pendingAuthProvider === 'discord'
      ? null
      : pendingAuthProvider;
  const [setupToken, setSetupToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

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
  const trackWelcomeSeen = useMutation(
    trpc.setupBootstrap.trackWelcomeSeen.mutationOptions(),
  );
  const bootstrapAuthProvider = getBootstrapAuthProvider(
    bootstrapStatus?.authSetup,
    pendingSetupAuthProvider,
  );
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
      const params = readSetupSearchParams();
      params.set('step', nextStep);
      commitSetupUrl(params);
    },
    [commitSetupUrl, readSetupSearchParams],
  );

  useRedirectToSignIn(shouldRedirectToSignIn);

  // Setup docs are server-rendered from this query parameter. Keep the
  // effective provider in the URL while signed out just as the signed-in flow
  // does, so provider-specific bootstrap instructions remain visible.
  useEffect(() => {
    const params = readSetupSearchParams();

    if (
      bootstrapAuthProvider &&
      params.get('authProvider') !== bootstrapAuthProvider
    ) {
      params.set('authProvider', bootstrapAuthProvider);
      commitSetupUrl(params);
    } else if (!bootstrapAuthProvider && params.has('authProvider')) {
      params.delete('authProvider');
      commitSetupUrl(params);
    }
  }, [bootstrapAuthProvider, commitSetupUrl, readSetupSearchParams]);

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
    if (!isSignedIn && setupToken && bootstrapStatus?.setupTokenSatisfied) {
      document.cookie = `${INVITE_COOKIE_NAME}=${encodeURIComponent(setupToken)}; path=/; max-age=3600; SameSite=Lax`;
    }
  }, [bootstrapStatus?.setupTokenSatisfied, isSignedIn, setupToken]);

  if (isSignedIn) {
    return null;
  }

  if (isBootstrapLoading || !bootstrapStatus?.setupOpen) {
    return <LoadingSetupFlow />;
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
          onContinue={setSetupToken}
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
          variants={stepTransitionVariants}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {bootstrapStep === 'welcome' && (
            <StepWelcome
              onContinue={() => {
                trackWelcomeSeen.mutate(
                  setupToken ? { setupToken } : undefined,
                );
                setBootstrapStepWithTransition(
                  getBootstrapStepAfterWelcome(bootstrapStatus.authSetup),
                );
              }}
            />
          )}
          {bootstrapStep === 'email-account' && (
            <StepBootstrapAccount
              onUseProviderSignIn={(provider) => {
                setAuthConfigEntryStep('email-account');
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
                setAuthConfigEntryStep('auth-provider');
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
              onBack={() => {
                setPendingAuthProvider(null);
                setBootstrapStepWithTransition(authConfigEntryStep);
              }}
              bootstrapMode={true}
              setupToken={setupToken}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function LoadingSetupFlow() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Spinner />
    </div>
  );
}

export const stepTransitionVariants: Variants = {
  enter: (direction: 'forward' | 'backward') => ({
    opacity: 0,
    y: direction === 'forward' ? 20 : -20,
  }),
  center: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: 'easeOut' },
  },
  exit: (direction: 'forward' | 'backward') => ({
    opacity: 0,
    y: direction === 'forward' ? -20 : 20,
    transition: { duration: 0.25, ease: 'easeOut' },
  }),
};

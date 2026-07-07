'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';
import { ONBOARDING_STEPS, type OnboardingStep } from './types';

/**
 * Reads initial state from URL search params (needed for OAuth return flows)
 * and clears the URL so the browser history stays clean.
 */
function readAndClearUrlParams() {
  if (typeof window === 'undefined') {
    return {
      urlStep: null,
      slackConnected: false,
      linearConnected: false,
      githubConnected: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const rawUrlStep = params.get('step');
  const urlStep = ONBOARDING_STEPS.includes(rawUrlStep as OnboardingStep)
    ? (rawUrlStep as OnboardingStep)
    : null;
  const slackConnected = params.get('slack') === 'connected';
  const linearConnected = params.get('linear') === 'connected';
  const githubConnected = params.get('github') === 'connected';

  // Strip query params so back/forward buttons don't accumulate history
  if (params.size > 0) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  return {
    urlStep,
    slackConnected,
    linearConnected,
    githubConnected,
  };
}

export function useOnboardingFlow() {
  const trpc = useTRPC();

  const { data: status, isLoading } = useQuery(
    trpc.onboarding.status.queryOptions(),
  );

  const [step, setStep] = useState<OnboardingStep>('welcome');

  // Track integration connection status in memory (set from OAuth return params)
  const [slackConnected, setSlackConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);

  const shouldSkip = useCallback(
    (s: OnboardingStep): boolean => {
      if (!status) return false;
      // Skip the welcome screen when the user has already linked any account,
      // so returning from an OAuth callback doesn't restart the flow.
      if (s === 'welcome') {
        const hasAnyProgress =
          status.userHasLinkedSlack ||
          status.userHasLinkedLinear ||
          status.userHasLinkedGitHub ||
          slackConnected ||
          linearConnected ||
          githubConnected;
        if (hasAnyProgress) return true;
      }
      if (
        s === 'slack' &&
        (!status.orgHasSlack || status.userHasLinkedSlack || slackConnected)
      )
        return true;
      if (
        s === 'linear' &&
        (!status.orgHasLinear || status.userHasLinkedLinear || linearConnected)
      )
        return true;
      if (s === 'github' && (status.userHasLinkedGitHub || githubConnected))
        return true;
      return false;
    },
    [status, slackConnected, linearConnected, githubConnected],
  );

  const findNextStep = useCallback(
    (fromIndex: number): OnboardingStep => {
      for (let i = fromIndex; i < ONBOARDING_STEPS.length; i++) {
        if (!shouldSkip(ONBOARDING_STEPS[i]!)) {
          return ONBOARDING_STEPS[i]!;
        }
      }
      return ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!;
    },
    [shouldSkip],
  );

  const goToStep = useCallback((newStep: OnboardingStep) => {
    setStep(newStep);
  }, []);

  const goToNextStep = useCallback(() => {
    const currentIndex = ONBOARDING_STEPS.indexOf(step);
    if (currentIndex < ONBOARDING_STEPS.length - 1) {
      const nextStep = findNextStep(currentIndex + 1);
      goToStep(nextStep);
    }
  }, [step, findNextStep, goToStep]);

  // Read URL params once on mount (for OAuth return) then keep everything in memory
  const initialized = useRef(false);
  useEffect(() => {
    if (isLoading || initialized.current) return;
    initialized.current = true;

    const {
      urlStep,
      slackConnected: sc,
      linearConnected: lc,
      githubConnected: gc,
    } = readAndClearUrlParams();

    if (sc) setSlackConnected(true);
    if (lc) setLinearConnected(true);
    if (gc) setGithubConnected(true);

    if (urlStep && ONBOARDING_STEPS.includes(urlStep)) {
      if (shouldSkip(urlStep)) {
        const index = ONBOARDING_STEPS.indexOf(urlStep);
        setStep(findNextStep(index));
      } else {
        setStep(urlStep);
      }
    } else {
      const firstValid = findNextStep(0);
      setStep(firstValid);
    }
    // Only run on mount and when status finishes loading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  return {
    step,
    goToNextStep,
    goToStep,
    slackConnected,
    linearConnected,
    githubConnected,
    status,
    isLoading,
  };
}

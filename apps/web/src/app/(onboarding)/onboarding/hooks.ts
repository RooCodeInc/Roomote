'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import {
  ONBOARDING_PROVIDER_IDS,
  ONBOARDING_STEP_IDS,
  type OnboardingStep,
} from './types';

function readUrlStep(): OnboardingStep | null {
  if (typeof window === 'undefined') return null;

  const step = new URLSearchParams(window.location.search).get('step');
  return ONBOARDING_STEP_IDS.includes(step as OnboardingStep)
    ? (step as OnboardingStep)
    : null;
}

export function useOnboardingFlow() {
  const trpc = useTRPC();
  const {
    data: status,
    isLoading,
    refetch,
  } = useQuery(trpc.onboarding.status.queryOptions());
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const initialized = useRef(false);

  const steps = useMemo<OnboardingStep[]>(() => {
    if (!status) return [];

    return [
      ...(status.isAdmin ? (['welcome'] as const) : []),
      ...status.linkableProviders
        .filter((provider) => provider.configured && !provider.linked)
        .map((provider) => provider.id),
      'invoke',
    ];
  }, [status]);

  const getNextStep = useCallback(
    (currentStep: OnboardingStep) => {
      const currentIndex = ONBOARDING_STEP_IDS.indexOf(currentStep);
      return (
        ONBOARDING_STEP_IDS.slice(currentIndex + 1).find((candidate) =>
          steps.includes(candidate),
        ) ?? 'invoke'
      );
    },
    [steps],
  );

  const goToNextStep = useCallback(() => {
    setStep((currentStep) => getNextStep(currentStep));
  }, [getNextStep]);

  useEffect(() => {
    if (isLoading || initialized.current || !status) return;
    initialized.current = true;

    const urlStep = readUrlStep();
    setStep(
      urlStep
        ? steps.includes(urlStep)
          ? urlStep
          : getNextStep(urlStep)
        : (steps[0] ?? 'invoke'),
    );
  }, [getNextStep, isLoading, status, steps]);

  const currentProvider = ONBOARDING_PROVIDER_IDS.includes(
    step as (typeof ONBOARDING_PROVIDER_IDS)[number],
  )
    ? status?.linkableProviders.find((provider) => provider.id === step)
    : undefined;

  return {
    step,
    currentProvider,
    goToNextStep,
    refetch,
    status,
    isLoading,
  };
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ROOMOTE_INFERENCE_PROVIDER_ID } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import { SETUP_STEPS, getSetupPath, type SetupStep } from './types';
import { hasSeenSetupWelcome } from './welcome-seen';

export type OpenRouterOauthEntryStatus = 'connected' | 'error';
type SetupStepTransitionDirection = 'forward' | 'backward';

type SetupEntryContext = {
  step: SetupStep | null;
  openrouterOauthStatus: OpenRouterOauthEntryStatus | null;
  openrouterOauthErrorReason: string | null;
};

function readUrlEntryContext(): SetupEntryContext {
  if (typeof window === 'undefined') {
    return {
      step: null,
      openrouterOauthStatus: null,
      openrouterOauthErrorReason: null,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const requestedStep = params.get('step');
  const openrouter = params.get('openrouter');
  const openrouterOauthStatus =
    openrouter === 'connected' || openrouter === 'error' ? openrouter : null;

  return {
    step: SETUP_STEPS.includes(requestedStep as SetupStep)
      ? (requestedStep as SetupStep)
      : null,
    openrouterOauthStatus,
    openrouterOauthErrorReason:
      openrouterOauthStatus === 'error' ? params.get('reason') : null,
  };
}

function readUrlStep(): SetupStep | null {
  if (typeof window === 'undefined') return null;
  const step = new URLSearchParams(window.location.search).get('step');
  return SETUP_STEPS.includes(step as SetupStep) ? (step as SetupStep) : null;
}

function hasBootstrapProgress(status: {
  authSetup: { setupSatisfiedByRuntimeEnv: boolean };
  modelSetup: { setupSatisfied: boolean; setupSatisfiedByRuntimeEnv: boolean };
  setupNewState: { authProvider: string | null; modelProvider: string | null };
}): boolean {
  return (
    status.authSetup.setupSatisfiedByRuntimeEnv ||
    status.modelSetup.setupSatisfied ||
    status.modelSetup.setupSatisfiedByRuntimeEnv ||
    status.setupNewState.authProvider !== null ||
    status.setupNewState.modelProvider !== null
  );
}

export function useSetupFlow(
  options: {
    enabled?: boolean;
  } = {},
) {
  const trpc = useTRPC();
  const router = useRouter();
  const statusQuery = useQuery(
    trpc.setupNew.status.queryOptions(undefined, {
      enabled: options.enabled ?? true,
      staleTime: 5_000,
    }),
  );
  const status = statusQuery.data;
  const [entryContext] = useState(readUrlEntryContext);
  const [step, setStep] = useState<SetupStep>('welcome');
  const [transitionDirection, setTransitionDirection] =
    useState<SetupStepTransitionDirection>('forward');
  const initializedRef = useRef(false);
  const stepRef = useRef(step);
  const navigationHistoryRef = useRef<SetupStep[]>([]);
  const pinnedStepRef = useRef<SetupStep | null>(null);
  const pendingSearchRef = useRef<string | null>(null);
  stepRef.current = step;

  const shouldSkip = useCallback(
    (candidate: SetupStep): boolean => {
      if (!status) return false;

      switch (candidate) {
        case 'welcome':
          return hasSeenSetupWelcome() || hasBootstrapProgress(status);
        case 'inference': {
          const trialAvailable = status.modelSetup.providers?.some(
            (provider) =>
              provider.id === ROOMOTE_INFERENCE_PROVIDER_ID &&
              provider.savedApiKeySatisfied,
          );
          const operatorConfigured = status.modelSetup.providers?.some(
            (provider) =>
              provider.id !== ROOMOTE_INFERENCE_PROVIDER_ID &&
              (provider.savedApiKeySatisfied ||
                provider.runtimeApiKeySatisfied),
          );
          return (
            !trialAvailable ||
            operatorConfigured ||
            status.modelSetup.runtimeRoomoteModelSatisfied ||
            status.modelSetup.persistedRoomoteModel !== null ||
            status.setupNewState.modelProvider !== null
          );
        }
        case 'env-vars':
          return status.modelSetup.setupSatisfied;
      }
    },
    [status],
  );

  const findNextStep = useCallback(
    (fromIndex = 0): SetupStep | null => {
      for (let index = fromIndex; index < SETUP_STEPS.length; index += 1) {
        const candidate = SETUP_STEPS[index];
        if (candidate && !shouldSkip(candidate)) return candidate;
      }
      return null;
    },
    [shouldSkip],
  );

  const readSetupSearchParams = useCallback(
    () =>
      new URLSearchParams(
        pendingSearchRef.current ??
          (typeof window === 'undefined' ? '' : window.location.search),
      ),
    [],
  );

  const commitSetupUrl = useCallback(
    (params: URLSearchParams, mode: 'push' | 'replace' = 'replace') => {
      pendingSearchRef.current = params.toString();
      router[mode](getSetupPath(params));
    },
    [router],
  );

  const setStepWithTransition = useCallback((nextStep: SetupStep) => {
    setTransitionDirection(
      SETUP_STEPS.indexOf(nextStep) >= SETUP_STEPS.indexOf(stepRef.current)
        ? 'forward'
        : 'backward',
    );
    stepRef.current = nextStep;
    setStep(nextStep);
  }, []);

  const navigateToStep = useCallback(
    (nextStep: SetupStep, mode: 'push' | 'replace') => {
      setStepWithTransition(nextStep);
      const params = readSetupSearchParams();
      params.set('step', nextStep);
      commitSetupUrl(params, mode);
    },
    [commitSetupUrl, readSetupSearchParams, setStepWithTransition],
  );

  const resolveStep = useCallback(
    (requested: SetupStep | null): SetupStep => {
      const firstPending = findNextStep() ?? 'env-vars';
      if (!requested) return firstPending;
      if (shouldSkip(requested) && pinnedStepRef.current !== requested) {
        return firstPending;
      }
      if (SETUP_STEPS.indexOf(requested) > SETUP_STEPS.indexOf(firstPending)) {
        return firstPending;
      }
      return requested;
    },
    [findNextStep, shouldSkip],
  );

  useEffect(() => {
    if (!status || initializedRef.current) return;
    initializedRef.current = true;
    const resolved = resolveStep(entryContext.step);
    navigateToStep(resolved, 'replace');

    const params = readSetupSearchParams();
    params.delete('openrouter');
    params.delete('reason');
    params.delete('slack');
    pendingSearchRef.current = params.toString();
    window.history.replaceState({}, '', getSetupPath(params));
  }, [
    entryContext.step,
    navigateToStep,
    readSetupSearchParams,
    resolveStep,
    status,
  ]);

  useEffect(() => {
    if (!status || !initializedRef.current) return;
    const current = stepRef.current;
    if (current !== pinnedStepRef.current && shouldSkip(current)) {
      const fallback = findNextStep();
      if (fallback) navigateToStep(fallback, 'replace');
    }
  }, [findNextStep, navigateToStep, shouldSkip, status]);

  useEffect(() => {
    const onPopState = () => {
      if (!status || !initializedRef.current) return;
      pendingSearchRef.current = null;
      navigationHistoryRef.current = [];
      pinnedStepRef.current = null;
      const requested = readUrlStep();
      const resolved = resolveStep(requested);
      if (resolved === requested) {
        setStepWithTransition(resolved);
      } else {
        navigateToStep(resolved, 'replace');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [navigateToStep, resolveStep, setStepWithTransition, status]);

  const goToStep = useCallback(
    (nextStep: SetupStep, revisit: { revisit?: boolean } = {}) => {
      if (nextStep !== step) navigationHistoryRef.current.push(step);
      pinnedStepRef.current = revisit.revisit ? nextStep : null;
      navigateToStep(nextStep, 'push');
    },
    [navigateToStep, step],
  );

  const previousStep = useMemo(() => {
    const historical = navigationHistoryRef.current.at(-1);
    if (historical) return historical;
    for (let index = SETUP_STEPS.indexOf(step) - 1; index >= 0; index -= 1) {
      const candidate = SETUP_STEPS[index];
      if (candidate && !shouldSkip(candidate)) return candidate;
    }
    return null;
  }, [shouldSkip, step]);

  const goToPreviousStep = useCallback(() => {
    const previous = navigationHistoryRef.current.pop() ?? previousStep;
    if (!previous) return;
    pinnedStepRef.current = shouldSkip(previous) ? previous : null;
    navigateToStep(previous, 'push');
  }, [navigateToStep, previousStep, shouldSkip]);

  const goToNextStep = useCallback(() => {
    const next = findNextStep(SETUP_STEPS.indexOf(step) + 1);
    if (!next) return;
    navigationHistoryRef.current.push(step);
    pinnedStepRef.current = null;
    navigateToStep(next, 'push');
  }, [findNextStep, navigateToStep, step]);

  return {
    step,
    transitionDirection,
    entryContext,
    goToStep,
    goToPreviousStep,
    goToNextStep,
    readSetupSearchParams,
    commitSetupUrl,
    status,
    isLoading: statusQuery.isLoading,
    isError: statusQuery.isError,
    error: statusQuery.error,
    canGoBack: previousStep !== null,
  };
}

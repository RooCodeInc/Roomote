'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SetupAuthProviderId } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { useUser } from '@/hooks/useUser';

import { SETUP_STEPS, getSetupStepPath, type SetupStep } from './types';
import { useSetupAsyncSession } from './setup-session';
import { hasSeenSetupWelcome } from './welcome-seen';

export type OpenRouterOauthEntryStatus = 'connected' | 'error';

type SetupEntryContext = {
  step: SetupStep | null;
  slackConnected: boolean;
  openrouterOauthStatus: OpenRouterOauthEntryStatus | null;
  openrouterOauthErrorReason: string | null;
};

function readOpenRouterOauthStatus(
  params: URLSearchParams,
): OpenRouterOauthEntryStatus | null {
  const status = params.get('openrouter');
  return status === 'connected' || status === 'error' ? status : null;
}

/**
 * Steps that stay visible when deep-linked even though their saved values
 * already satisfy the flow: the credential config steps, so users can fix
 * saved-but-wrong credentials (e.g. a GitHub App key that fails at connect),
 * and the sandbox provider picker, so the deployment default can be switched
 * after setup.
 */
const REVISITABLE_SETUP_STEPS: readonly SetupStep[] = [
  'auth-env-vars',
  'env-vars',
  'compute-provider',
  'compute-config',
  'source-control-config',
];

function readUrlEntryContext(): SetupEntryContext {
  if (typeof window === 'undefined') {
    return {
      step: null,
      slackConnected: false,
      openrouterOauthStatus: null,
      openrouterOauthErrorReason: null,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const step = params.get('step');
  const openrouterOauthStatus = readOpenRouterOauthStatus(params);

  return {
    step: SETUP_STEPS.includes(step as SetupStep) ? (step as SetupStep) : null,
    slackConnected: params.get('slack') === 'connected',
    openrouterOauthStatus,
    openrouterOauthErrorReason:
      openrouterOauthStatus === 'error' ? params.get('reason') : null,
  };
}

function readUrlStep(): SetupStep | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const step = new URLSearchParams(window.location.search).get('step');
  return SETUP_STEPS.includes(step as SetupStep) ? (step as SetupStep) : null;
}

/**
 * Transient OAuth/callback params consumed once on entry. Unlike `step`, these
 * must not survive a refresh, so they are stripped after the entry context is
 * read while the canonical `step` param is preserved in the URL.
 */
const TRANSIENT_ENTRY_PARAMS = ['slack', 'openrouter', 'reason'] as const;

function stripTransientEntryParams() {
  if (typeof window === 'undefined') {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  let changed = false;

  for (const key of TRANSIENT_ENTRY_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  const query = params.toString();
  window.history.replaceState(
    {},
    '',
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
}

function hasRealProgress(status: {
  hasGitHub: boolean;
  hasSlack: boolean;
  hasSlackInstallation: boolean;
  onboardingSucceeded: boolean;
  authSetup: {
    setupSatisfiedByRuntimeEnv: boolean;
  };
  modelSetup: {
    setupSatisfied: boolean;
    setupSatisfiedByRuntimeEnv: boolean;
  };
  sourceControlSetup: {
    setupSatisfied: boolean;
  };
  setupNewState: {
    authProvider: string | null;
    modelProvider: string | null;
    computeProvider: string | null;
    sourceControlProvider: string | null;
    selectedRepositoryIds: string[];
    onboardingTaskId: string | null;
  };
}): boolean {
  return (
    status.hasGitHub ||
    status.hasSlackInstallation ||
    status.onboardingSucceeded ||
    status.authSetup.setupSatisfiedByRuntimeEnv ||
    status.sourceControlSetup.setupSatisfied ||
    status.setupNewState.authProvider !== null ||
    status.setupNewState.modelProvider !== null ||
    status.setupNewState.computeProvider !== null ||
    status.setupNewState.sourceControlProvider !== null ||
    status.setupNewState.selectedRepositoryIds.length > 0 ||
    status.setupNewState.onboardingTaskId !== null
  );
}

function hasLegacyOnboardingTask(status: {
  setupNewState: {
    onboardingTaskId: string | null;
    slackChannel: string | null;
    slackThreadTs: string | null;
  };
}): boolean {
  return (
    status.setupNewState.onboardingTaskId !== null &&
    status.setupNewState.slackChannel === null &&
    status.setupNewState.slackThreadTs === null
  );
}

function toTimestamp(value: Date | string | null): number {
  if (!value) {
    return Number.NaN;
  }

  return new Date(value).getTime();
}

function isInitialReplayVisit(status: {
  setupCompletedAt: Date | string | null;
  setupNewState: {
    selectedRepositoryIds: string[];
    onboardingTaskStartedAt: Date | string | null;
  };
}): boolean {
  if (!status.setupCompletedAt) {
    return false;
  }

  if (
    status.setupNewState.selectedRepositoryIds.length > 0 &&
    status.setupNewState.onboardingTaskStartedAt === null
  ) {
    return false;
  }

  const setupCompletedAtMs = toTimestamp(status.setupCompletedAt);
  const onboardingTaskStartedAtMs = toTimestamp(
    status.setupNewState.onboardingTaskStartedAt,
  );

  return !(
    Number.isFinite(setupCompletedAtMs) &&
    Number.isFinite(onboardingTaskStartedAtMs) &&
    onboardingTaskStartedAtMs > setupCompletedAtMs
  );
}

export function useSetupFlow(
  options: {
    enabled?: boolean;
    pendingAuthProvider?: SetupAuthProviderId | null;
  } = {},
) {
  const trpc = useTRPC();
  const router = useRouter();
  const { user } = useUser();
  const queryEnabled = options.enabled ?? true;
  const pendingAuthProvider = options.pendingAuthProvider ?? null;

  const {
    data: status,
    isLoading,
    isError,
    error,
  } = useQuery(
    trpc.setupNew.status.queryOptions(undefined, {
      enabled: queryEnabled,
      staleTime: 5_000,
    }),
  );
  const ensureDefaultAgents = useMutation(
    trpc.setupNew.ensureDefaultAgents.mutationOptions(),
  );

  const [step, setStep] = useState<SetupStep>('welcome');
  const [entryContext] = useState<SetupEntryContext>(() =>
    readUrlEntryContext(),
  );
  const initialized = useRef(false);
  const pinnedUrlStepRef = useRef<SetupStep | null>(null);
  const lastUrlStepRef = useRef<SetupStep | null>(null);
  const syncedStepRef = useRef<SetupStep | null>(null);
  const ensuredTaskIdRef = useRef<string | null>(null);
  const setupSession = useSetupAsyncSession({
    currentTaskId: status?.setupNewState.onboardingTaskId ?? null,
  });
  const communicationStepResolved =
    setupSession.session.communicationStep.state === 'skipped' ||
    setupSession.session.communicationStep.state === 'completed';
  const hasUnlockedPostOnboardingFlow = useCallback(() => {
    if (!setupSession.session.onboardingTask.postOnboardingUnlocked) {
      return false;
    }

    // When an onboarding task exists, scope the unlock to that task so a new
    // task (or any onboardingTaskId change) resets it via the setup session's
    // currentTaskId effect. When no task exists yet — e.g. skipping
    // environment setup from repo selection before any onboarding task has
    // started — honor the unlock until a task starts, otherwise the
    // auto-skip watchdog treats invoke as unreachable and yanks the user
    // back to repo selection.
    if (status?.setupNewState.onboardingTaskId) {
      return (
        setupSession.session.onboardingTask.taskId ===
        status.setupNewState.onboardingTaskId
      );
    }

    return true;
  }, [
    setupSession.session.onboardingTask.postOnboardingUnlocked,
    setupSession.session.onboardingTask.taskId,
    status?.setupNewState.onboardingTaskId,
  ]);
  const hasPostOnboardingAccess = useCallback(
    (forceUnlocked = false) => {
      return (
        !!status &&
        (status.onboardingSucceeded ||
          (status.setupNewState.onboardingTaskId !== null &&
            !status.onboardingFailed) ||
          forceUnlocked ||
          hasUnlockedPostOnboardingFlow())
      );
    },
    [hasUnlockedPostOnboardingFlow, status],
  );

  const shouldSkip = useCallback(
    (candidate: SetupStep): boolean => {
      if (!status) {
        return false;
      }

      const replayEntryVisit = isInitialReplayVisit(status);
      const activeQualificationBlock =
        status.setupQualification.activeBlock ?? null;
      const effectiveAuthProvider =
        pendingAuthProvider ??
        status.setupNewState.authProvider ??
        status.authSetup.runtimeConfiguredProvider;
      const sourceControlLockedByRuntime =
        status.sourceControlSetup.lockReason === 'runtime_env';
      const effectiveSourceControlProvider =
        status.setupNewState.sourceControlProvider ??
        status.sourceControlSetup.runtimeConfiguredProvider;
      const effectiveCommunicationProvider =
        status.setupNewState.authProvider ??
        status.authSetup.runtimeConfiguredProvider ??
        status.authSetup.selectedProvider;

      switch (candidate) {
        case 'welcome':
          // The signed-out bootstrap flow shows the same welcome screen
          // before account creation, so skip the wizard's copy when this
          // browser session already saw it.
          return (
            activeQualificationBlock !== null ||
            (!replayEntryVisit &&
              (hasSeenSetupWelcome() || hasRealProgress(status)))
          );
        case 'auth-provider':
          return communicationStepResolved || effectiveAuthProvider !== null;
        case 'auth-env-vars':
          return (
            effectiveAuthProvider === null ||
            (status.authSetup.providers.find(
              (provider) => provider.id === effectiveAuthProvider,
            )?.setupSatisfied ??
              false)
          );
        case 'env-vars':
          return status.modelSetup.setupSatisfied;
        case 'source-control-provider':
          return (
            status.sourceControlSetup.setupSatisfied ||
            sourceControlLockedByRuntime ||
            status.setupNewState.sourceControlProvider != null
          );
        case 'source-control-config': {
          if (status.sourceControlSetup.setupSatisfied) {
            return true;
          }

          const selectedProvider = effectiveSourceControlProvider ?? null;

          if (!selectedProvider) {
            return true;
          }

          const providerStatus = status.sourceControlSetup.providers.find(
            (provider) => provider.provider === selectedProvider,
          );

          return providerStatus?.configSatisfied ?? false;
        }
        case 'source-control-connect':
          return status.sourceControlSetup.setupSatisfied;
        case 'qualification-blocked':
          return activeQualificationBlock === null;
        case 'compute-provider':
          return (
            status.computeSetup.setupSatisfied ||
            status.setupNewState.computeProvider != null
          );
        case 'compute-config': {
          if (status.computeSetup.setupSatisfied) {
            return true;
          }

          const selectedComputeProvider =
            status.setupNewState.computeProvider ?? null;

          if (!selectedComputeProvider) {
            return true;
          }

          const computeProviderStatus = status.computeSetup.providers.find(
            (provider) => provider.provider === selectedComputeProvider,
          );

          return computeProviderStatus?.configSatisfied ?? false;
        }
        case 'slack':
          if (communicationStepResolved) {
            return true;
          }

          if (hasLegacyOnboardingTask(status)) {
            return true;
          }

          if (effectiveCommunicationProvider === 'slack') {
            return status.hasSlack;
          }

          if (effectiveCommunicationProvider === 'microsoft') {
            return false;
          }

          return true;
        case 'repo-selection':
          return (
            !replayEntryVisit &&
            status.setupNewState.onboardingTaskId !== null &&
            !status.onboardingFailed
          );
        case 'invoke':
          return !hasPostOnboardingAccess();
        default:
          return false;
      }
    },
    [
      communicationStepResolved,
      hasOnboardingProgress,
      communicationStepSkipped,
      hasPostOnboardingAccess,
      pendingAuthProvider,
      status,
    ],
  );

  const shouldSkipPostOnboarding = useCallback(
    (
      candidate: SetupStep,
      options: {
        forceUnlocked?: boolean;
      } = {},
    ): boolean => {
      const { forceUnlocked = false } = options;

      switch (candidate) {
        case 'invoke':
          return !hasPostOnboardingAccess(forceUnlocked);
        default:
          return shouldSkip(candidate);
      }
    },
    [hasPostOnboardingAccess, shouldSkip],
  );

  const findNextStep = useCallback(
    (fromIndex: number): SetupStep => {
      for (let index = fromIndex; index < SETUP_STEPS.length; index += 1) {
        const candidate = SETUP_STEPS[index];

        if (candidate && !shouldSkip(candidate)) {
          return candidate;
        }
      }

      return hasPostOnboardingAccess() ? 'invoke' : 'repo-selection';
    },
    [hasPostOnboardingAccess, shouldSkip],
  );

  const findNextPostOnboardingStep = useCallback(
    ({
      fromIndex = SETUP_STEPS.indexOf('invoke'),
      forceUnlocked,
    }: {
      fromIndex?: number;
      forceUnlocked?: boolean;
    } = {}): SetupStep => {
      for (let index = fromIndex; index < SETUP_STEPS.length; index += 1) {
        const candidate = SETUP_STEPS[index];

        if (
          candidate &&
          !shouldSkipPostOnboarding(candidate, { forceUnlocked })
        ) {
          return candidate;
        }
      }

      return 'invoke';
    },
    [shouldSkipPostOnboarding],
  );

  const pushStepUrl = useCallback(
    (nextStep: SetupStep) => {
      lastUrlStepRef.current = nextStep;
      router.push(getSetupStepPath(nextStep));
    },
    [router],
  );

  const replaceStepUrl = useCallback(
    (nextStep: SetupStep) => {
      lastUrlStepRef.current = nextStep;
      router.replace(getSetupStepPath(nextStep));
    },
    [router],
  );

  // Resolve a requested step (from a deep link or browser back/forward) into
  // the step that should actually render, applying the same skip/gating rules
  // as the rest of the flow. Also updates the revisit pin so the auto-skip
  // watchdog leaves an intentionally revisited config step visible.
  const resolveDeepLinkStep = useCallback(
    (requested: SetupStep | null): SetupStep => {
      if (!requested) {
        pinnedUrlStepRef.current = null;
        return findNextStep(0);
      }

      // Explicit links to credential config steps always render, even when
      // earlier steps are pending or the step's saved values already satisfy
      // the flow — this is how users get back to fix saved-but-wrong
      // credentials (e.g. from the GitHub callback error page).
      if (REVISITABLE_SETUP_STEPS.includes(requested)) {
        pinnedUrlStepRef.current = requested;
        return requested;
      }

      pinnedUrlStepRef.current = null;
      const firstPendingStep = findNextStep(0);

      if (
        SETUP_STEPS.indexOf(requested) > SETUP_STEPS.indexOf(firstPendingStep)
      ) {
        return firstPendingStep;
      }

      if (shouldSkip(requested)) {
        return findNextStep(SETUP_STEPS.indexOf(requested) + 1);
      }

      return requested;
    },
    [findNextStep, shouldSkip],
  );

  useEffect(() => {
    if (!status || !setupSession.hydrated || initialized.current) {
      return;
    }

    initialized.current = true;
    const requestedStep = entryContext.step;
    const resolvedStep = resolveDeepLinkStep(requestedStep);
    setStep(resolvedStep);

    if (resolvedStep === requestedStep) {
      // Valid deep link: keep the canonical `step` in the URL and only drop
      // the transient callback params so a refresh does not reprocess them.
      stripTransientEntryParams();
      lastUrlStepRef.current = resolvedStep;
    } else {
      // Missing, invalid, or gated step: correct the URL to the resolved step
      // without adding a history entry.
      replaceStepUrl(resolvedStep);
    }
  }, [
    entryContext.step,
    replaceStepUrl,
    resolveDeepLinkStep,
    setupSession.hydrated,
    status,
  ]);

  // Auto-skip watchdog: when setup state changes underneath the user and the
  // current step becomes impossible, fall back to the first pending step.
  useEffect(() => {
    if (!status || !setupSession.hydrated || !initialized.current) {
      return;
    }

    const fallbackStep = findNextStep(0);

    setStep((currentStep) => {
      if (isInitialReplayVisit(status)) {
        return currentStep;
      }

      if (currentStep === pinnedUrlStepRef.current) {
        return currentStep;
      }

      if (shouldSkip(currentStep)) {
        return fallbackStep;
      }

      return currentStep;
    });
  }, [findNextStep, setupSession.hydrated, shouldSkip, status]);

  // Keep the URL in sync with the active step. User navigation and deep-link
  // corrections write the URL themselves (recorded in lastUrlStepRef); any
  // other step change here is an automatic correction (e.g. the auto-skip
  // watchdog) that replaces the current history entry.
  useEffect(() => {
    if (syncedStepRef.current === null) {
      // Establish the baseline from the current (possibly pre-resolution) step
      // on the first run without writing the URL — the init effect owns the
      // first URL write. Doing this before the `initialized` gate ensures the
      // baseline is set even when the initial resolved step matches the
      // default and `setStep` is a no-op, so a later watchdog correction is
      // still detected and replaces the URL.
      syncedStepRef.current = step;
      return;
    }

    if (!initialized.current) {
      return;
    }

    if (syncedStepRef.current === step) {
      return;
    }

    syncedStepRef.current = step;

    if (lastUrlStepRef.current === step) {
      return;
    }

    replaceStepUrl(step);
  }, [replaceStepUrl, step]);

  // React to browser back/forward by resolving the active step from the URL.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePopState = () => {
      if (!status || !setupSession.hydrated || !initialized.current) {
        return;
      }

      const requestedStep = readUrlStep();
      const resolvedStep = resolveDeepLinkStep(requestedStep);

      if (resolvedStep === requestedStep) {
        // Browser already navigated to a valid step URL; just record it so the
        // URL-sync effect does not rewrite the entry the user landed on.
        lastUrlStepRef.current = resolvedStep;
      } else {
        replaceStepUrl(resolvedStep);
      }

      setStep(resolvedStep);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [replaceStepUrl, resolveDeepLinkStep, setupSession.hydrated, status]);

  useEffect(() => {
    if (
      !status?.onboardingSucceeded ||
      !status.setupNewState.onboardingTaskId ||
      user?.isAdmin !== true
    ) {
      if (!status?.setupNewState.onboardingTaskId) {
        ensuredTaskIdRef.current = null;
      }
      return;
    }

    if (ensuredTaskIdRef.current === status.setupNewState.onboardingTaskId) {
      return;
    }

    ensuredTaskIdRef.current = status.setupNewState.onboardingTaskId;
    ensureDefaultAgents.mutate();
  }, [
    ensureDefaultAgents,
    status?.onboardingSucceeded,
    status?.setupNewState.onboardingTaskId,
    user?.isAdmin,
  ]);

  const goToStep = useCallback(
    (nextStep: SetupStep, options: { revisit?: boolean } = {}) => {
      // Revisit navigations pin the step so the auto-skip watchdog leaves it
      // visible even though its saved state already satisfies the flow.
      pinnedUrlStepRef.current = options.revisit ? nextStep : null;
      setStep(nextStep);
      pushStepUrl(nextStep);
    },
    [pushStepUrl],
  );

  const goToNextStep = useCallback(() => {
    const currentIndex = SETUP_STEPS.indexOf(step);
    const nextStep = findNextStep(currentIndex + 1);
    pinnedUrlStepRef.current = null;
    setStep(nextStep);
    pushStepUrl(nextStep);
  }, [findNextStep, pushStepUrl, step]);

  const goToNextPostOnboardingStep = useCallback(
    (forceUnlocked = false) => {
      const nextStep = findNextPostOnboardingStep({ forceUnlocked });
      pinnedUrlStepRef.current = null;
      setStep(nextStep);
      pushStepUrl(nextStep);
    },
    [findNextPostOnboardingStep, pushStepUrl],
  );

  const advancePostOnboardingStep = useCallback(
    (resolvedStep: SetupStep) => {
      const nextStep = findNextPostOnboardingStep({
        fromIndex: SETUP_STEPS.indexOf(resolvedStep) + 1,
        forceUnlocked: true,
      });
      pinnedUrlStepRef.current = null;
      setStep(nextStep);
      pushStepUrl(nextStep);
    },
    [findNextPostOnboardingStep, pushStepUrl],
  );

  return {
    step,
    entryContext,
    goToStep,
    goToNextStep,
    goToNextPostOnboardingStep,
    advancePostOnboardingStep,
    status,
    isLoading: isLoading || !setupSession.hydrated,
    isError,
    error,
    setupSession,
  };
}

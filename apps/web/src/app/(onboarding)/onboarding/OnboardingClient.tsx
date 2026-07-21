'use client';

import { AnimatePresence, motion } from 'motion/react';

import { Spinner } from '@/components/system';

import { StepWelcome } from '../setup/StepWelcome';
import { StepInvoke } from './StepInvoke';
import { useOnboardingFlow } from './hooks';
import { ProviderLinkStep } from './ProviderLinkStep';
import type { OnboardingLinkableProvider } from './types';

export function OnboardingClient({ githubAppSlug }: { githubAppSlug: string }) {
  const { step, currentProvider, goToNextStep, refetch, status, isLoading } =
    useOnboardingFlow();
  const linkableProviders = status?.linkableProviders as
    | readonly OnboardingLinkableProvider[]
    | undefined;
  const configuredCommunicationProviders = (linkableProviders ?? []).filter(
    (
      provider,
    ): provider is Extract<
      OnboardingLinkableProvider,
      { category: 'communication' }
    > => provider.configured && provider.category === 'communication',
  );
  const configuredSourceControlProviders = (linkableProviders ?? []).filter(
    (
      provider,
    ): provider is Extract<
      OnboardingLinkableProvider,
      { category: 'source-control' }
    > => provider.configured && provider.category === 'source-control',
  );

  if (isLoading) {
    return (
      <div className="flex items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 40 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { duration: 0.3, ease: [0.0, 0.0, 0.2, 1] },
          }}
          exit={{
            opacity: 0,
            y: -40,
            transition: { duration: 0.2, ease: [0.4, 0.0, 1, 1] },
          }}
        >
          {step === 'welcome' && (
            <StepWelcome isOnboarding onContinue={goToNextStep} />
          )}
          {currentProvider && (
            <ProviderLinkStep
              provider={currentProvider}
              githubAppSlug={githubAppSlug}
              onContinue={goToNextStep}
              onLinked={() => {
                void refetch();
                goToNextStep();
              }}
            />
          )}
          {step === 'invoke' && (
            <StepInvoke
              communicationProviders={configuredCommunicationProviders.map(
                (provider) => provider.id,
              )}
              sourceControlProviders={configuredSourceControlProviders.map(
                (provider) => provider.id,
              )}
              includeAutomations={status?.isAdmin === true}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

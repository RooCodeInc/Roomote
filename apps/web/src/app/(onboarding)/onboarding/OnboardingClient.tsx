'use client';

import { AnimatePresence, motion } from 'motion/react';

import { Spinner } from '@/components/system';

import { StepWelcome } from '../setup/StepWelcome';
import { StepGitHub } from './StepGitHub';
import { StepInvoke } from './StepInvoke';
import { StepLinear } from './StepLinear';
import { StepSlack } from './StepSlack';
import { useOnboardingFlow } from './hooks';

export function OnboardingClient({ githubAppSlug }: { githubAppSlug: string }) {
  const {
    step,
    goToNextStep,
    slackConnected,
    linearConnected,
    githubConnected,
    status,
    isLoading,
  } = useOnboardingFlow();

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
          {step === 'slack' && <StepSlack onContinue={goToNextStep} />}
          {step === 'linear' && (
            <StepLinear
              onContinue={goToNextStep}
              previousStepCompleted={slackConnected ? 'Slack' : undefined}
            />
          )}
          {step === 'github' && (
            <StepGitHub
              githubAppSlug={githubAppSlug}
              onContinue={goToNextStep}
              previousStepCompleted={linearConnected ? 'Linear' : undefined}
            />
          )}
          {step === 'invoke' && (
            <StepInvoke
              previousStepCompleted={githubConnected ? 'GitHub' : undefined}
              communicationProviders={
                status?.orgHasSlack || status?.userHasLinkedSlack
                  ? ['slack']
                  : []
              }
              sourceControlProviders={
                status?.userHasLinkedGitHub || githubConnected ? ['github'] : []
              }
              includeLinear={
                status?.orgHasLinear ||
                status?.userHasLinkedLinear ||
                linearConnected
              }
              includeAutomations={status?.isAdmin === true}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

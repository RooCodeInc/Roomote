'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useOnboardingFlow } from './hooks';
import { Spinner } from '@/components/system';
import { StepWelcome } from './StepWelcome';
import { StepSlack } from './StepSlack';
import { StepLinear } from './StepLinear';
import { StepGitHub } from './StepGitHub';
import { StepInvoke } from './StepInvoke';

export default function OnboardingPage() {
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
          {step === 'welcome' && <StepWelcome onContinue={goToNextStep} />}
          {step === 'slack' && <StepSlack onContinue={goToNextStep} />}
          {step === 'linear' && (
            <StepLinear
              onContinue={goToNextStep}
              previousStepCompleted={slackConnected ? 'Slack' : undefined}
            />
          )}
          {step === 'github' && (
            <StepGitHub
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
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

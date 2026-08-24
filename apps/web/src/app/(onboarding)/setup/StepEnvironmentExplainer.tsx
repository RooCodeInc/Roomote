'use client';

import { useTelemetry } from '@/hooks/useTelemetry';
import { ArrowRight, Button } from '@/components/system';

import { SetupFooter } from './SetupFooter';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';
import Image from 'next/image';

const ENVIRONMENT_EXPLAINER_STEP = getSetupStepDefinition(
  'environment-explainer',
);

export function StepEnvironmentExplainer({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack?: () => void;
}) {
  const { capture } = useTelemetry();

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={ENVIRONMENT_EXPLAINER_STEP.title} />
      <div className="md:flex md:gap-2 md:items-start">
        <div className="space-y-2 w-full">
          <p className="font-semibold">
            Environments let Roomote verify its work by actually running your
            projects in is sandboxes. They include:
          </p>
          <ul className="list-disc pl-5">
            <li>Code and runtime dependencies</li>
            <li>What services make up your project and how to start them</li>
            <li>What ports they run on, so you can access live PR previews</li>
          </ul>
          <p>
            Roomote can set them up on its own, you just need to pick the
            relevant repo(s).
          </p>
        </div>
        <Image
          src="/elements/sandboxes.png"
          alt=""
          width={160}
          height={129}
          className="relative hidden md:block max-w-40"
        />
      </div>
      <SetupFooter onBack={onBack}>
        <Button
          type="button"
          onClick={() => {
            capture('activation_setup_environment_explained', {
              action: 'continue',
            });
            onContinue();
          }}
        >
          Continue
          <ArrowRight />
        </Button>
      </SetupFooter>
    </div>
  );
}

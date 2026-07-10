'use client';

import { PRODUCT_NAME } from '@roomote/types';

import { Button, ArrowRight } from '@/components/system';
import { StepTitle } from '../setup/StepTitle';
import { OnboardingWordmark } from '../OnboardingWordmark';

export function StepWelcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-6 max-w-xl relative">
      <StepTitle
        text={`Welcome to ${PRODUCT_NAME}!`}
        className="text-3xl"
        showCheckbox={false}
      />
      <p>
        {PRODUCT_NAME} is your always-on engineer. Ask questions, parallelize
        tasks, fix bugs, churn through chores, setup proactive work and more.
      </p>
      <p>
        You don&apos;t even need to be an engineer. {PRODUCT_NAME} runs in
        isolated sandboxes and verifies its own work, so it doesn't blindly
        break things. You can be confident you&apos;re having an impact and not
        making mistakes.
      </p>
      <Button size="default" onClick={onContinue}>
        Get started
        <ArrowRight />
      </Button>
    </div>
  );
}

'use client';

import { Button, ArrowRight } from '@/components/system';
import { PRODUCT_NAME } from '@roomote/types';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';
import { markSetupWelcomeSeen } from './welcome-seen';

const WELCOME_STEP = getSetupStepDefinition('welcome');

export function StepWelcome({
  onContinue,
  onConnectCloud,
}: {
  onContinue: () => void;
  onConnectCloud?: () => void;
}) {
  return (
    <div className="relative w-full max-w-lg space-y-6 py-2 md:py-0">
      <StepTitle text={WELCOME_STEP.title} />
      <p>
        {PRODUCT_NAME} is your always-on engineer. Ask questions, parallelize
        tasks, fix bugs, churn through chores, setup proactive work and more.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        {onConnectCloud ? (
          <Button
            size="default"
            className="w-full sm:w-auto"
            onClick={() => {
              markSetupWelcomeSeen();
              onConnectCloud();
            }}
          >
            Connect Roomote Cloud
            <ArrowRight />
          </Button>
        ) : null}
        <Button
          size="default"
          variant={onConnectCloud ? 'outline' : 'default'}
          className="w-full sm:w-auto"
          onClick={() => {
            markSetupWelcomeSeen();
            onContinue();
          }}
        >
          {onConnectCloud ? 'Set up everything myself' : 'Get started'}
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

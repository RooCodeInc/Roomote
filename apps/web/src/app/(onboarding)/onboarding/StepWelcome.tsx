'use client';

import { PRODUCT_NAME } from '@roomote/types';

import { Button, ArrowRight } from '@/components/system';
import { StepTitle } from '../setup/StepTitle';
import { OnboardingWordmark } from '../OnboardingWordmark';

export function StepWelcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-6 max-w-xl relative">
      <OnboardingWordmark />
      <StepTitle
        text={`Welcome to ${PRODUCT_NAME}!`}
        className="text-3xl"
        showCheckbox={false}
      />
      <p>
        {PRODUCT_NAME} gives you and your team AI agents that work on your
        codebase: handling chores, making changes, fixing bugs, reviewing PRs
        and more.
      </p>
      <p>
        You don&apos;t even need to be an engineer. {`${PRODUCT_NAME} agents`}{' '}
        are smart and safe, so you&apos;re confident you&apos;re having an
        impact and not making mistakes.
      </p>
      <Button size="default" onClick={onContinue}>
        Get started
        <ArrowRight />
      </Button>
    </div>
  );
}

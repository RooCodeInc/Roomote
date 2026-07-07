'use client';

import {
  SETUP_AUTH_PROVIDER_CATALOG,
  type SetupAuthProviderId,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const AUTH_PROVIDER_STEP = getSetupStepDefinition('auth-provider');

export function StepAuthProvider({
  onContinue,
  onBack,
  onSkip,
}: {
  onContinue: (provider: SetupAuthProviderId) => void;
  onBack?: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={AUTH_PROVIDER_STEP.title} />
      <div className="space-y-4 max-w-xl">
        <p>
          Roomote needs a messaging tool to talk to you and your team directly.
          <br />
          What do you use?
        </p>

        <div className="space-y-0.5 max-w-sm">
          {SETUP_AUTH_PROVIDER_CATALOG.map((provider) => {
            return (
              <Button
                key={provider.id}
                type="button"
                onClick={() => onContinue(provider.id as SetupAuthProviderId)}
                className={cn(
                  'group flex w-full py-5',
                  'hover:text-accent-foreground hover:bg-foreground',
                )}
              >
                <BrandIcon
                  icon={provider.id}
                  name=""
                  className="size-4 shrink-0"
                />
                <span className="font-medium grow text-left">
                  {provider.label}
                </span>
                <ArrowRight />
              </Button>
            );
          })}
        </div>

        {onSkip ? (
          <button
            type="button"
            className="cursor-pointer text-sm text-muted-foreground underline"
            onClick={onSkip}
          >
            Do this later
          </button>
        ) : null}

        {onBack ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={onBack}
          >
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}

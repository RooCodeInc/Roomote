'use client';

import {
  SETUP_AUTH_PROVIDER_CATALOG,
  type SetupAuthProviderId,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { getSetupStepDefinition } from './types';

const AUTH_PROVIDER_STEP = getSetupStepDefinition('auth-provider');
export type CommunicationProviderChoice = SetupAuthProviderId | 'telegram';

export function StepAuthProvider({
  onContinue,
  onBack,
  onSkip,
  includeTelegram = false,
  disabled = false,
}: {
  onContinue: (provider: CommunicationProviderChoice) => void;
  onBack?: () => void;
  onSkip?: () => void;
  includeTelegram?: boolean;
  disabled?: boolean;
}) {
  const providers = includeTelegram
    ? [
        ...SETUP_AUTH_PROVIDER_CATALOG,
        { id: 'telegram' as const, label: 'Telegram' },
      ]
    : SETUP_AUTH_PROVIDER_CATALOG;
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
          {providers.map((provider) => {
            return (
              <Button
                key={provider.id}
                type="button"
                onClick={() => onContinue(provider.id)}
                disabled={disabled}
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

        <SetupFooter onBack={onBack} backDisabled={disabled}>
          {onSkip ? (
            <button
              type="button"
              className="cursor-pointer text-sm text-muted-foreground underline disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onSkip}
              disabled={disabled}
            >
              Do this later
            </button>
          ) : null}
        </SetupFooter>
      </div>
    </div>
  );
}

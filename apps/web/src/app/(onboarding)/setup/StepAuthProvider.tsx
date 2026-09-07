'use client';

import {
  SETUP_AUTH_PROVIDER_CATALOG,
  type SetupAuthProviderId,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
export type AdditionalCommunicationProviderChoice = 'telegram' | 'discord';
export type CommunicationProviderChoice =
  | SetupAuthProviderId
  | AdditionalCommunicationProviderChoice;

const ADDITIONAL_COMMUNICATION_PROVIDERS: Record<
  AdditionalCommunicationProviderChoice,
  { id: AdditionalCommunicationProviderChoice; label: string }
> = {
  telegram: { id: 'telegram', label: 'Telegram' },
  discord: { id: 'discord', label: 'Discord' },
};

export function StepAuthProvider({
  onContinue,
  onSkip,
  additionalProviders = [],
  disabled = false,
}: {
  onContinue: (provider: CommunicationProviderChoice) => void;
  onBack?: () => void;
  onSkip?: () => void;
  additionalProviders?: readonly AdditionalCommunicationProviderChoice[];
  disabled?: boolean;
}) {
  const providers = [
    ...SETUP_AUTH_PROVIDER_CATALOG,
    ...additionalProviders.map(
      (provider) => ADDITIONAL_COMMUNICATION_PROVIDERS[provider],
    ),
  ];
  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text="Communication provider" />
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
          {onSkip ? (
            <Button
              className="w-full py-5"
              variant="outline"
              onClick={onSkip}
              disabled={disabled}
            >
              <span className="font-medium grow text-left">Do this later</span>
              <ArrowRight />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

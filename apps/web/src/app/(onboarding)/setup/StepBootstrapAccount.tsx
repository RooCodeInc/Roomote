'use client';

import type { SetupAuthProviderId } from '@roomote/types';

import { ArrowRight, BrandIcon, Button, KeyRound } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';

/**
 * First-admin account creation during bootstrap. The setup token in the
 * invite cookie acts as the system invite, so email/password remains available
 * as a fallback before any sign-in provider is configured.
 */
export function StepBootstrapAccount({
  onUseProviderSignIn,
  onUseEmailPassword,
}: {
  onUseProviderSignIn: (provider: SetupAuthProviderId) => void;
  onUseEmailPassword: () => void;
}) {
  const providerButtons: {
    id: Extract<SetupAuthProviderId, 'slack' | 'microsoft'>;
    label: string;
    icon: 'slack' | 'teams';
  }[] = [
    { id: 'slack', label: 'Use Slack', icon: 'slack' },
    { id: 'microsoft', label: 'Use Teams', icon: 'teams' },
  ];

  return (
    <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
      <StepTitle text="Authentication setup" />
      <p>
        Do you use any of these communication tools? They make auth easier (no
        invites or passwords to deal with) and talking to Roomote more
        convenient.
        <br />
        If not, you can also just do email/password.
      </p>
      <div className="space-y-2 max-w-md">
        {providerButtons.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            onClick={() => onUseProviderSignIn(provider.id)}
            className={cn(
              'group flex w-full py-5',
              'hover:text-accent-foreground hover:bg-foreground',
            )}
          >
            <BrandIcon
              icon={provider.icon}
              name=""
              className="size-4 shrink-0"
            />
            <span className="font-medium grow text-left">{provider.label}</span>
            <ArrowRight />
          </Button>
        ))}

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onUseEmailPassword}
        >
          <KeyRound />
          <span className="font-medium grow text-left">Use email/password</span>
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

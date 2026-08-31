'use client';

import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  type SourceControlProvider,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { getSetupStepDefinition } from './types';

const SOURCE_CONTROL_PROVIDER_STEP = getSetupStepDefinition(
  'source-control-provider',
);

export function StepSourceControlProvider({
  sourceControlSetup,
  onContinue,
  onBack,
  disabled = false,
  embedded = false,
}: {
  sourceControlSetup: {
    connectedProvider: SourceControlProvider | null;
    selectedProvider: SourceControlProvider | null;
    preselectedProvider: SourceControlProvider;
    providers: Array<{
      provider: SourceControlProvider;
      label: string;
      connected: boolean;
    }>;
  };
  onContinue: (provider: SourceControlProvider) => void;
  onBack?: () => void;
  disabled?: boolean;
  /** Omit legacy setup-step chrome when rendered in a setup session card. */
  embedded?: boolean;
}) {
  return (
    <div
      className={
        embedded
          ? 'space-y-4'
          : 'relative w-full max-w-2xl space-y-6 py-2 md:py-0'
      }
    >
      {!embedded ? (
        <StepTitle text={SOURCE_CONTROL_PROVIDER_STEP.title} />
      ) : null}
      <div className="space-y-4 max-w-xl">
        {!embedded ? (
          <p>
            Roomote needs access to your repositories to work on your codebase.
            Otherwise it would be flying blind :)
          </p>
        ) : null}

        <p>Where do you keep your repos?</p>

        <div className="space-y-0.5 max-w-sm">
          {SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.map((provider) => {
            const status = sourceControlSetup.providers.find(
              (candidate) => candidate.provider === provider.provider,
            );

            return (
              <Button
                key={provider.provider}
                type="button"
                onClick={() => onContinue(provider.provider)}
                disabled={disabled}
                className={cn(
                  'group flex w-full py-5',
                  'hover:text-accent-foreground hover:bg-foreground',
                )}
              >
                <BrandIcon
                  icon={provider.provider}
                  name=""
                  className="size-4 shrink-0"
                />
                <span className="font-medium grow text-left">
                  {provider.label}
                  {status?.connected ? ' (connected)' : ''}
                </span>
                <ArrowRight />
              </Button>
            );
          })}
        </div>

        <SetupFooter onBack={onBack} />
      </div>
    </div>
  );
}

'use client';

import type { ComputeProvider, SetupComputeStatus } from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const COMPUTE_PROVIDER_STEP = getSetupStepDefinition('compute-provider');

const BRAND_ICON_BY_PROVIDER = {
  modal: 'modal',
  docker: 'docker',
  daytona: 'daytona',
  e2b: 'e2b',
  blaxel: 'blaxel',
} satisfies Record<ComputeProvider, string>;

export function StepComputeProvider({
  computeSetup,
  onContinue,
  disabled = false,
}: {
  computeSetup: SetupComputeStatus;
  onContinue: (provider: ComputeProvider) => void;
  disabled?: boolean;
}) {
  // All providers are offered. Hosted providers whose worker image is not yet
  // available are still selectable: their config step collects a shared worker
  // image (and can auto-derive or provision the provider artifact from it), so
  // the operator is no longer dead-ended by missing infrastructure.
  const availableProviders = computeSetup.providers;

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={COMPUTE_PROVIDER_STEP.title} />
      <div className="space-y-4 max-w-xl">
        <p>
          Roomote runs each task on isolated VMs, commonly known as sandboxes.
          This allows for focused changes and the ability to test things
          end-to-end before committing.
        </p>
        <p>Where do you want to run your sandboxes?</p>

        <div className="space-y-0.5 max-w-sm">
          {availableProviders.map((provider) => {
            return (
              <Button
                key={provider.provider}
                type="button"
                onClick={() => onContinue(provider.provider)}
                disabled={disabled}
                className={cn(
                  'group flex w-full items-center gap-3 py-5',
                  'hover:text-accent-foreground hover:bg-foreground',
                )}
              >
                <BrandIcon
                  icon={BRAND_ICON_BY_PROVIDER[provider.provider]}
                  name=""
                  className="size-4 shrink-0"
                />
                <span className="font-medium grow text-left">
                  {provider.label}
                </span>
                {provider.comment ? (
                  <span className="text-xs opacity-60">{provider.comment}</span>
                ) : null}
                <ArrowRight />
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

'use client';

import {
  isComputeOperatorEditableField,
  type ComputeProvider,
  type SetupComputeStatus,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';

const BRAND_ICON_BY_PROVIDER = {
  modal: 'modal',
  docker: 'docker',
  daytona: 'daytona',
  e2b: 'e2b',
  blaxel: 'blaxel',
  box: 'box-sandbox',
  azure: 'azure',
  roomote: 'roomote',
} satisfies Record<ComputeProvider, string>;

export function SandboxProviderPicker({
  computeSetup,
  onContinue,
  disabled = false,
}: {
  computeSetup: SetupComputeStatus;
  onContinue: (provider: ComputeProvider) => void;
  disabled?: boolean;
}) {
  // Hosted providers whose worker image is not yet available remain selectable:
  // their config step can collect or provision the missing infrastructure.
  // Explicit deployment exclusions are stronger and must not be offered.
  // Deployment-managed providers (no operator-editable fields, e.g. Roomote
  // Cloud) cannot be configured from the wizard, so they are only offered
  // when the deployment already satisfies them.
  const excludedProviders = new Set(computeSetup.excludedProviders ?? []);
  const availableProviders = computeSetup.providers.filter(
    (provider) =>
      !excludedProviders.has(provider.provider) &&
      (provider.fields.some(isComputeOperatorEditableField) ||
        provider.configSatisfied),
  );

  return (
    <div className="max-w-xl space-y-3">
      <p className="font-medium">Where should I run your tasks?</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {availableProviders.map((provider) => {
          return (
            <Button
              key={provider.provider}
              type="button"
              onClick={() => onContinue(provider.provider)}
              disabled={disabled}
              variant="outline"
              className="group h-auto w-full justify-start gap-3 p-3 text-left"
            >
              <BrandIcon
                icon={BRAND_ICON_BY_PROVIDER[provider.provider]}
                name=""
                className="shrink-0"
              />
              <span className="min-w-0 grow">
                <span className="block font-medium">{provider.label}</span>
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
  );
}

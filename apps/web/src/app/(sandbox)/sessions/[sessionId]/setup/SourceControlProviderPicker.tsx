'use client';

import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  type SourceControlProvider,
} from '@roomote/types';

import { ArrowRight, BrandIcon, Button } from '@/components/system';

export function SourceControlProviderPicker({
  sourceControlSetup,
  onContinue,
  disabled = false,
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
  disabled?: boolean;
}) {
  return (
    <div className="max-w-xl space-y-3">
      <p className="font-medium">Where do you keep your repositories?</p>
      <div className="grid gap-2 sm:grid-cols-2">
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
              variant="outline"
              className="group h-auto w-full justify-start gap-3 p-3 text-left"
            >
              <BrandIcon
                icon={provider.provider}
                name=""
                className="shrink-0"
              />
              <span className="min-w-0 grow font-medium">
                {provider.label}
                {status?.connected ? ' (connected)' : ''}
              </span>
              <ArrowRight />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

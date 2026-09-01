'use client';

import {
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG,
  type SourceControlProvider,
} from '@roomote/types';

import { BrandIcon, Button } from '@/components/system';

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
              variant="default"
              size="sm"
              className="w-full justify-start gap-3 text-left"
            >
              <BrandIcon
                icon={provider.provider}
                name=""
                className="size-4 shrink-0"
              />
              <span className="min-w-0 grow font-medium">
                {provider.label}
                {status?.connected ? ' (connected)' : ''}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

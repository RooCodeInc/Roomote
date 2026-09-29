'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Zap,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  MODEL_FAST_MODE_CAPABILITIES,
  getModelFastModeCapability,
} from '@roomote/types';
import type { ModelFastMode, SetupModelProviderStatus } from '@roomote/types';

function isProviderConnected(
  providers: SetupModelProviderStatus[],
  providerId: string,
): boolean {
  const provider = providers.find((candidate) => candidate.id === providerId);

  return Boolean(
    provider &&
    (provider.savedApiKeySatisfied || provider.runtimeApiKeySatisfied),
  );
}

function FastModeSelect({
  capabilityId,
  mode,
  disabled,
  onChange,
}: {
  capabilityId: string;
  mode: ModelFastMode;
  disabled: boolean;
  onChange: (capabilityId: string, mode: ModelFastMode) => void;
}) {
  const capability = getModelFastModeCapability(capabilityId);

  return (
    <Select
      value={mode}
      disabled={disabled}
      onValueChange={(value) => onChange(capabilityId, value as ModelFastMode)}
    >
      <SelectTrigger
        className="w-32"
        aria-label={`Fast mode for ${capability?.modelName ?? capabilityId} on ${capability?.providerLabel ?? 'unsupported route'}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">Inherit</SelectItem>
        <SelectItem value="normal">Normal</SelectItem>
        <SelectItem value="fast">Fast</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function ModelFastModeSettings({
  connectedProviders,
  overrides,
}: {
  connectedProviders: SetupModelProviderStatus[];
  overrides: Record<string, ModelFastMode>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    trpc.taskModels.updateFastMode.mutationOptions(),
  );
  const chatgptConnected = isProviderConnected(
    connectedProviders,
    CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  );
  const openaiConnected = isProviderConnected(connectedProviders, 'openai');
  const visibleCapabilities = MODEL_FAST_MODE_CAPABILITIES.filter(
    (capability) =>
      (capability.authKind === 'chatgpt-oauth' && chatgptConnected) ||
      (capability.authKind === 'openai-api-key' && openaiConnected),
  );
  const visibleCapabilityIds = new Set(
    visibleCapabilities.map((capability) => capability.id),
  );
  const staleOverrides = Object.entries(overrides).filter(
    ([capabilityId, mode]) =>
      mode !== 'inherit' && !visibleCapabilityIds.has(capabilityId),
  );

  if (visibleCapabilities.length === 0 && staleOverrides.length === 0) {
    return null;
  }

  const saveMode = async (capabilityId: string, mode: ModelFastMode) => {
    try {
      await updateMutation.mutateAsync({ capabilityId, mode });
      await queryClient.invalidateQueries({
        queryKey: trpc.taskModels.get.queryKey(),
      });
      toast.success('Saved the model Fast mode.');
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not save the Fast mode.',
      );
    }
  };

  return (
    <Section icon={Zap} title="Model Fast modes">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Choose how each supported provider route handles Fast mode. Inherit
          uses the ChatGPT account setting above or the OpenAI project default.
          Fast access depends on the provider account, project, and region. It
          may cost more, and OpenAI can serve Standard instead during traffic
          ramps.
        </p>

        {chatgptConnected ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">ChatGPT subscription</p>
            {visibleCapabilities
              .filter((capability) => capability.authKind === 'chatgpt-oauth')
              .map((capability) => (
                <div
                  key={capability.id}
                  className="flex items-center justify-between gap-3 border-b border-background py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {capability.modelName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {overrides[capability.id] === 'fast'
                        ? `${capability.fastDescription} ${capability.eligibilityDescription}`
                        : overrides[capability.id] === 'normal'
                          ? 'Use standard speed even when the account Fast mode default is on.'
                          : capability.inheritDescription}
                    </p>
                  </div>
                  <FastModeSelect
                    capabilityId={capability.id}
                    mode={overrides[capability.id] ?? 'inherit'}
                    disabled={updateMutation.isPending}
                    onChange={(id, mode) => void saveMode(id, mode)}
                  />
                </div>
              ))}
          </div>
        ) : null}

        {openaiConnected ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">OpenAI API key</p>
            {visibleCapabilities
              .filter((capability) => capability.authKind === 'openai-api-key')
              .map((capability) => (
                <div
                  key={capability.id}
                  className="flex items-center justify-between gap-3 border-b border-background py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {capability.modelName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {chatgptConnected
                        ? 'OpenAI API key settings are saved for this route; ChatGPT subscription currently takes precedence for openai/ models.'
                        : overrides[capability.id] === 'fast'
                          ? `${capability.fastDescription} ${capability.eligibilityDescription}`
                          : overrides[capability.id] === 'normal'
                            ? 'Use standard processing for this model.'
                            : capability.inheritDescription}
                    </p>
                  </div>
                  <FastModeSelect
                    capabilityId={capability.id}
                    mode={overrides[capability.id] ?? 'inherit'}
                    disabled={updateMutation.isPending}
                    onChange={(id, mode) => void saveMode(id, mode)}
                  />
                </div>
              ))}
          </div>
        ) : null}

        {staleOverrides.length > 0 ? (
          <div className="space-y-2 rounded-md border border-warning/40 p-3">
            <p className="text-sm font-medium text-warning">
              Some saved Fast mode choices no longer match a connected route.
              Reset them to Inherit to clear them.
            </p>
            {staleOverrides.map(([capabilityId, mode]) => {
              const capability = getModelFastModeCapability(capabilityId);

              return (
                <div
                  key={capabilityId}
                  className="flex items-center justify-between gap-3"
                >
                  <p className="min-w-0 truncate text-xs text-muted-foreground">
                    {capability
                      ? `${capability.providerLabel} · ${capability.modelName} (${mode})`
                      : `Unsupported route · ${capabilityId} (${mode})`}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() => void saveMode(capabilityId, 'inherit')}
                  >
                    Reset
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

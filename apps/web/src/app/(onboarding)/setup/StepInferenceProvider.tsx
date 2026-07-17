'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  type SetupModelProviderId,
  type SetupModelStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Button,
  Check,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/system';
import { ChatGptConnectDialog } from '@/components/settings/ChatGptConnectDialog';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { getSetupStepDefinition } from './types';
import type { OpenRouterOauthEntryStatus } from './hooks';

const ENV_VARS_STEP = getSetupStepDefinition('env-vars');
const MASKED_VALUE = '••••••••••••••••••••••••••••';

const OPENROUTER_OAUTH_FALLBACK_ERROR_MESSAGE =
  "Couldn't finish connecting to OpenRouter. Please try again or paste an API key instead.";

const OPENROUTER_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  unauthorized:
    'You need to be signed in as an admin to connect OpenRouter. Please try again.',
  access_denied:
    'The OpenRouter authorization was cancelled or denied. You can try again or paste an API key instead.',
  missing_code:
    "OpenRouter didn't return an authorization code. Please try connecting again.",
  missing_verifier:
    'The OpenRouter connection attempt expired. Please try connecting again.',
  exchange_failed: OPENROUTER_OAUTH_FALLBACK_ERROR_MESSAGE,
};

function getOpenRouterOauthErrorMessage(reason: string | null): string {
  return (
    (reason ? OPENROUTER_OAUTH_ERROR_MESSAGES[reason] : undefined) ??
    OPENROUTER_OAUTH_FALLBACK_ERROR_MESSAGE
  );
}

function getProviderStatus(
  modelSetup: SetupModelStatus,
  providerId: SetupModelProviderId,
) {
  return modelSetup.providers.find((provider) => provider.id === providerId);
}

export function StepInferenceProvider({
  modelSetup,
  openRouterOauthStatus = null,
  openRouterOauthErrorReason = null,
  onContinue,
  onBack,
}: {
  modelSetup: SetupModelStatus;
  openRouterOauthStatus?: OpenRouterOauthEntryStatus | null;
  openRouterOauthErrorReason?: string | null;
  onContinue: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] =
    useState<SetupModelProviderId>(modelSetup.preselectedProvider);
  const [apiKey, setApiKey] = useState('');
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >({});
  const [discoveredModels, setDiscoveredModels] = useState<
    Array<{ modelId: string; displayName: string | null }>
  >([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [editingSavedValue, setEditingSavedValue] = useState(false);
  const [isChatGptDialogOpen, setIsChatGptDialogOpen] = useState(false);
  const chatgptStatusQuery = useQuery(
    trpc.chatgptSubscription.status.queryOptions(undefined, {
      enabled: selectedProvider === CHATGPT_SUBSCRIPTION_PROVIDER_ID,
    }),
  );
  const chatgptStatus = chatgptStatusQuery.data ?? null;
  const saveModelConfig = useMutation(
    trpc.setupNew.saveModelConfig.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        onContinue();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const discoverProviderModels = useMutation(
    trpc.taskModels.discoverProviderModels.mutationOptions(),
  );
  const qualifyProviderModel = useMutation(
    trpc.taskModels.qualifyProviderModel.mutationOptions(),
  );

  useEffect(() => {
    setSelectedProvider(modelSetup.preselectedProvider);
  }, [modelSetup.preselectedProvider]);

  useEffect(() => {
    setApiKey('');
    setAdditionalEnvValues({});
    setDiscoveredModels([]);
    setSelectedModelId('');
    setEditingSavedValue(false);
    setIsChatGptDialogOpen(false);
  }, [selectedProvider]);

  useEffect(() => {
    if (openRouterOauthStatus === 'connected') {
      toast.success(
        'Connected to OpenRouter. Your new API key has been saved.',
        {
          id: 'openrouter-oauth-result',
        },
      );
    } else if (openRouterOauthStatus === 'error') {
      toast.error(getOpenRouterOauthErrorMessage(openRouterOauthErrorReason), {
        id: 'openrouter-oauth-result',
      });
    }
  }, [openRouterOauthStatus, openRouterOauthErrorReason]);

  const selectedProviderStatus = useMemo(
    () => getProviderStatus(modelSetup, selectedProvider),
    [modelSetup, selectedProvider],
  );
  const isChatGptProvider =
    selectedProviderStatus?.authKind === 'oauth' &&
    selectedProvider === CHATGPT_SUBSCRIPTION_PROVIDER_ID;
  const isEndpointProvider = selectedProviderStatus?.authKind === 'endpoint';
  const chatgptConnected = Boolean(modelSetup.chatgptConnected);
  const hasRuntimeProviderKey =
    selectedProviderStatus?.runtimeApiKeySatisfied === true;
  const hasSavedProviderKey =
    selectedProviderStatus?.savedApiKeySatisfied === true;
  const primaryCredentialLabel =
    selectedProviderStatus?.envVarLabel ?? 'API key';
  const additionalEnvFields = selectedProviderStatus?.additionalEnvFields ?? [];
  // The server status list already excludes hidden providers that are not
  // connected, so the picker only offers providers that can be selected.
  const sortedModelProviders = useMemo(
    () =>
      [...modelSetup.providers].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [modelSetup.providers],
  );
  const shouldShowSavedValueMask =
    !isEndpointProvider &&
    !hasRuntimeProviderKey &&
    hasSavedProviderKey &&
    apiKey.length === 0 &&
    !editingSavedValue;
  const shouldShowConfiguredMask =
    hasRuntimeProviderKey || shouldShowSavedValueMask;
  const canContinueWithoutApiKey = hasRuntimeProviderKey || hasSavedProviderKey;
  const hasMissingRequiredFields =
    !canContinueWithoutApiKey &&
    additionalEnvFields.some(
      (field) =>
        field.required &&
        (additionalEnvValues[field.envVarName]?.trim() ?? '').length === 0,
    );
  const isActionDisabled =
    saveModelConfig.isPending ||
    hasMissingRequiredFields ||
    (!canContinueWithoutApiKey && apiKey.trim().length === 0);

  const handleContinue = async () => {
    if (isEndpointProvider) {
      const result = await qualifyProviderModel.mutateAsync({
        provider: selectedProvider as 'ollama' | 'vllm' | 'litellm',
        modelId: selectedModelId,
        baseUrl: apiKey.trim() || undefined,
        apiKey:
          additionalEnvValues[
            `${selectedProvider.toUpperCase()}_API_KEY`
          ]?.trim() || undefined,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
    }
    await saveModelConfig.mutateAsync({
      provider: selectedProvider,
      apiKey: apiKey.trim() || undefined,
      ...(additionalEnvFields.length > 0 && { additionalEnvValues }),
      ...(isEndpointProvider && { modelId: selectedModelId }),
    });
  };

  const handleDiscoverModels = async () => {
    if (!isEndpointProvider) {
      return;
    }
    const result = await discoverProviderModels.mutateAsync({
      provider: selectedProvider as 'ollama' | 'vllm' | 'litellm',
      baseUrl: apiKey.trim() || undefined,
      apiKey:
        additionalEnvValues[
          `${selectedProvider.toUpperCase()}_API_KEY`
        ]?.trim() || undefined,
    });
    if (result.error) {
      toast.error(result.error);
      return;
    }
    setDiscoveredModels(result.models);
    setSelectedModelId(result.models[0]?.modelId ?? '');
  };

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={ENV_VARS_STEP.title} />
      <div className="space-y-3">
        <p>
          Roomote needs a model provider for, you know, AI stuff. Pick yours and
          connect it:
        </p>
      </div>

      <div className="flex items-center gap-2 max-w-lg">
        <Select
          value={selectedProvider}
          onValueChange={(value) =>
            setSelectedProvider(value as SetupModelProviderId)
          }
        >
          <SelectTrigger aria-label="Model provider">
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {sortedModelProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isChatGptProvider ? null : (
          <Input
            secret={!isEndpointProvider && !hasRuntimeProviderKey}
            value={shouldShowConfiguredMask ? MASKED_VALUE : apiKey}
            onFocus={() => {
              if (shouldShowSavedValueMask) {
                setEditingSavedValue(true);
              }
            }}
            onBlur={() => {
              if (hasSavedProviderKey && apiKey.length === 0) {
                setEditingSavedValue(false);
              }
            }}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              hasRuntimeProviderKey
                ? ''
                : `${primaryCredentialLabel} for ${selectedProviderStatus?.label ?? 'provider'}`
            }
            disabled={saveModelConfig.isPending || hasRuntimeProviderKey}
            data-1p-ignore
          />
        )}

        {(hasRuntimeProviderKey || hasSavedProviderKey) && <Check />}
      </div>

      {selectedProviderStatus?.credentialHelp && !hasRuntimeProviderKey ? (
        <p className="max-w-lg text-xs text-muted-foreground">
          {selectedProviderStatus.credentialHelp.text}{' '}
          <a
            className="font-medium underline underline-offset-2 hover:text-foreground"
            href={selectedProviderStatus.credentialHelp.href}
            target="_blank"
            rel="noreferrer"
          >
            {selectedProviderStatus.credentialHelp.linkLabel}
          </a>
          .
        </p>
      ) : null}

      {isChatGptProvider && !hasRuntimeProviderKey ? (
        <div className="flex max-w-lg items-center gap-3">
          {chatgptConnected ? (
            <span className="text-sm text-muted-foreground">
              {chatgptStatus?.email
                ? `Connected as ${chatgptStatus.email}`
                : 'Connected to a ChatGPT account.'}
            </span>
          ) : (
            <>
              <span className="text-sm text-muted-foreground">
                Connect a ChatGPT Plus or Pro account to run tasks on your
                subscription:
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saveModelConfig.isPending}
                onClick={() => setIsChatGptDialogOpen(true)}
              >
                Connect ChatGPT
              </Button>
            </>
          )}
        </div>
      ) : null}

      {!hasRuntimeProviderKey &&
        additionalEnvFields.map((field) => (
          <div
            key={field.envVarName}
            className="flex max-w-lg items-center gap-2"
          >
            <span className="w-48 shrink-0 text-sm text-muted-foreground">
              {field.label}
              {field.required ? '' : ' (optional)'}
            </span>
            <Input
              secret={field.secret}
              value={additionalEnvValues[field.envVarName] ?? ''}
              onChange={(event) =>
                setAdditionalEnvValues((values) => ({
                  ...values,
                  [field.envVarName]: event.target.value,
                }))
              }
              placeholder={field.placeholder}
              disabled={saveModelConfig.isPending}
              aria-label={`${field.label} for ${selectedProviderStatus?.label ?? 'provider'}`}
              data-1p-ignore
            />
          </div>
        ))}

      {isEndpointProvider ? (
        <div className="flex max-w-lg items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleDiscoverModels()}
            disabled={
              discoverProviderModels.isPending || apiKey.trim().length === 0
            }
          >
            {discoverProviderModels.isPending
              ? 'Discovering...'
              : 'Discover models'}
          </Button>
          {discoveredModels.length > 0 ? (
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger aria-label="Discovered model">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {discoveredModels.map((model) => (
                  <SelectItem key={model.modelId} value={model.modelId}>
                    {model.displayName ?? model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}

      {selectedProvider === 'openrouter' && !hasRuntimeProviderKey && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            or, if you don&apos;t have a key handy:
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saveModelConfig.isPending}
            onClick={() =>
              window.location.assign('/api/openrouter-oauth/initiate')
            }
          >
            Connect with OpenRouter
          </Button>
        </div>
      )}

      <ChatGptConnectDialog
        open={isChatGptDialogOpen}
        onOpenChange={setIsChatGptDialogOpen}
        onConnected={async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.setupNew.status.queryKey(),
          });
        }}
      />

      <SetupFooter onBack={onBack}>
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={
            isActionDisabled || (isEndpointProvider && !selectedModelId)
          }
        >
          {saveModelConfig.isPending ? (
            <>
              Saving...
              <Spinner />
            </>
          ) : (
            <>
              Continue <ArrowRight />
            </>
          )}
        </Button>
      </SetupFooter>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  getDefaultAdditionalEnvValues,
  getSetupModelProvider,
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
import { AdditionalEnvFieldInput } from '@/components/settings/AdditionalEnvFieldInput';
import { ChatGptConnectDialog } from '@/components/settings/ChatGptConnectDialog';
import { GitHubCopilotConnectDialog } from '@/components/settings/GitHubCopilotConnectDialog';
import { XaiConnectDialog } from '@/components/settings/XaiConnectDialog';

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
  providerId: SetupModelProviderId | null,
) {
  return modelSetup.providers.find((provider) => provider.id === providerId);
}

export function StepInferenceProvider({
  modelSetup,
  openRouterOauthStatus = null,
  openRouterOauthErrorReason = null,
  onContinue,
  onBack,
  onSelectedProviderChange,
}: {
  modelSetup: SetupModelStatus;
  openRouterOauthStatus?: OpenRouterOauthEntryStatus | null;
  openRouterOauthErrorReason?: string | null;
  onContinue: () => void;
  onBack?: () => void;
  onSelectedProviderChange?: (provider: SetupModelProviderId | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] =
    useState<SetupModelProviderId | null>(null);
  const selectProvider = useCallback(
    (provider: SetupModelProviderId | null) => {
      setSelectedProvider(provider);
      onSelectedProviderChange?.(provider);
    },
    [onSelectedProviderChange],
  );
  const [apiKey, setApiKey] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >({});
  const [editingSavedValue, setEditingSavedValue] = useState(false);
  const [isChatGptDialogOpen, setIsChatGptDialogOpen] = useState(false);
  const [isGitHubCopilotDialogOpen, setIsGitHubCopilotDialogOpen] =
    useState(false);
  const [isXaiDialogOpen, setIsXaiDialogOpen] = useState(false);
  const chatgptStatusQuery = useQuery(
    trpc.chatgptSubscription.status.queryOptions(undefined, {
      enabled: selectedProvider === CHATGPT_SUBSCRIPTION_PROVIDER_ID,
    }),
  );
  const chatgptStatus = chatgptStatusQuery.data ?? null;
  const xaiStatusQuery = useQuery(
    trpc.xaiSubscription.status.queryOptions(undefined, {
      enabled: selectedProvider === 'xai',
    }),
  );
  const xaiStatus = xaiStatusQuery.data ?? null;
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
    setApiKey(
      selectedProvider === 'ollama'
        ? 'http://localhost:11434'
        : selectedProvider === 'vllm'
          ? 'http://localhost:8000/v1'
          : '',
    );
    setConnectionName('');
    // Seeded from the catalog rather than the fetched status so this effect
    // stays keyed on `selectedProvider` alone; depending on the status query
    // would reset in-progress input on every refetch.
    setAdditionalEnvValues(
      getDefaultAdditionalEnvValues(
        selectedProvider
          ? (getSetupModelProvider(selectedProvider).additionalEnvFields ?? [])
          : [],
      ),
    );
    setEditingSavedValue(false);
    setIsChatGptDialogOpen(false);
    setIsGitHubCopilotDialogOpen(false);
    setIsXaiDialogOpen(false);
  }, [selectedProvider]);

  useEffect(() => {
    if (openRouterOauthStatus === 'connected') {
      selectProvider('openrouter');
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
  }, [openRouterOauthStatus, openRouterOauthErrorReason, selectProvider]);

  const selectedProviderStatus = useMemo(
    () => getProviderStatus(modelSetup, selectedProvider),
    [modelSetup, selectedProvider],
  );
  const isChatGptProvider =
    selectedProviderStatus?.authKind === 'oauth' &&
    selectedProvider === CHATGPT_SUBSCRIPTION_PROVIDER_ID;
  const isGitHubCopilotProvider = selectedProvider === 'github-copilot';
  const isXaiProvider = selectedProvider === 'xai';
  const isOAuthProvider = selectedProviderStatus?.authKind === 'oauth';
  const isEndpointProvider = selectedProviderStatus?.authKind === 'endpoint';
  const chatgptConnected = Boolean(modelSetup.chatgptConnected);
  const githubCopilotConnected = Boolean(modelSetup.githubCopilotConnected);
  const xaiSubscriptionConnected = Boolean(
    modelSetup.xaiSubscriptionConnected || xaiStatus?.connected,
  );
  const hasRuntimeProviderKey =
    selectedProviderStatus?.runtimeApiKeySatisfied === true;
  const hasSavedProviderKey =
    selectedProviderStatus?.savedApiKeySatisfied === true ||
    (isXaiProvider && xaiSubscriptionConnected);
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
    // OAuth-only xAI has no API key to mask.
    !(
      isXaiProvider &&
      xaiSubscriptionConnected &&
      !modelSetup.xaiApiKeyConnected
    ) &&
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
  const requiresConnectionName =
    selectedProvider === OPENAI_COMPATIBLE_PROVIDER_ID ||
    selectedProviderStatus?.allowMultipleConnections === true;
  const hasMissingConnectionName =
    requiresConnectionName && connectionName.trim().length === 0;
  const isActionDisabled =
    saveModelConfig.isPending ||
    discoverProviderModels.isPending ||
    qualifyProviderModel.isPending ||
    selectedProvider === null ||
    hasMissingRequiredFields ||
    hasMissingConnectionName ||
    (!canContinueWithoutApiKey && apiKey.trim().length === 0);
  const isCheckingEndpoint =
    isEndpointProvider &&
    (discoverProviderModels.isPending || qualifyProviderModel.isPending);

  const handleContinue = async () => {
    if (!selectedProvider) {
      return;
    }

    let modelId: string | undefined;
    let endpointConnectionMessage: string | undefined;
    let qualificationError: string | undefined;
    const submittedCredential = shouldShowConfiguredMask
      ? undefined
      : apiKey.trim() || undefined;

    if (isEndpointProvider) {
      const provider = selectedProvider as
        | 'openai-compatible'
        | 'ollama'
        | 'vllm'
        | 'litellm';
      const endpointApiKeyEnvVarName = additionalEnvFields.find(
        (field) => field.secret,
      )?.envVarName;
      const connection = {
        baseUrl: submittedCredential,
        apiKey: endpointApiKeyEnvVarName
          ? additionalEnvValues[endpointApiKeyEnvVarName]?.trim() || undefined
          : undefined,
      };
      const discovery = await discoverProviderModels.mutateAsync({
        provider,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
      });
      if (discovery.error) {
        toast.error(discovery.error);
        return;
      }

      for (const candidate of discovery.recommendedModels) {
        const result = await qualifyProviderModel.mutateAsync({
          provider,
          modelId: candidate.modelId,
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
        });
        if (result.success) {
          modelId = candidate.modelId;
          break;
        }
        qualificationError = result.error;
      }

      if (!modelId) {
        toast.error(
          discovery.recommendedModels.length === 0
            ? `Found ${discovery.modelCount} ${discovery.modelCount === 1 ? 'model' : 'models'}, but none that can power Roomote. It needs tool calling and at least 7B parameters.`
            : `Found ${discovery.modelCount} ${discovery.modelCount === 1 ? 'model that meets' : 'models that meet'} Roomote's 7B minimum, but none support the required tool calling. ${qualificationError ?? 'Check the provider tool-calling configuration.'}`,
        );
        return;
      }

      endpointConnectionMessage = `Connected to ${selectedProviderStatus?.label ?? 'the provider'} and selected ${modelId.replace(`${provider}/`, '')} from ${discovery.modelCount} discovered ${discovery.modelCount === 1 ? 'model' : 'models'}.`;
    }
    await saveModelConfig.mutateAsync({
      provider: selectedProvider,
      apiKey: submittedCredential,
      ...(additionalEnvFields.length > 0 && { additionalEnvValues }),
      ...(requiresConnectionName && {
        connectionName: connectionName.trim(),
      }),
      ...(modelId && { modelId }),
    });
    if (endpointConnectionMessage) {
      toast.success(endpointConnectionMessage);
    }
  };

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={ENV_VARS_STEP.title} />
      <div className="space-y-3">
        <p>
          Roomote needs a model provider for, you know, AI stuff. Pick yours and
          connect it.
        </p>
        <p>Popular choices are ChatGPT subscriptions and OpenRouter.</p>
      </div>

      <div className="flex items-center gap-2 max-w-lg">
        <Select
          value={selectedProvider ?? undefined}
          onValueChange={(value) =>
            selectProvider(value as SetupModelProviderId)
          }
        >
          <SelectTrigger aria-label="Model provider" className="min-w-44">
            <SelectValue placeholder="Pick your provider" />
          </SelectTrigger>
          <SelectContent>
            {sortedModelProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedProvider && !isOAuthProvider ? (
          <Input
            type={isEndpointProvider ? 'url' : undefined}
            inputMode={isEndpointProvider ? 'url' : undefined}
            autoComplete={isEndpointProvider ? 'url' : undefined}
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
        ) : null}

        {isChatGptProvider && !hasRuntimeProviderKey && !chatgptConnected ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={saveModelConfig.isPending}
            onClick={() => setIsChatGptDialogOpen(true)}
          >
            Connect ChatGPT
          </Button>
        ) : null}

        {isGitHubCopilotProvider &&
        !hasRuntimeProviderKey &&
        !githubCopilotConnected ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={saveModelConfig.isPending}
            onClick={() => setIsGitHubCopilotDialogOpen(true)}
          >
            Connect GitHub Copilot
          </Button>
        ) : null}

        {(hasRuntimeProviderKey || hasSavedProviderKey) && <Check />}
      </div>

      {isXaiProvider && !hasRuntimeProviderKey && !xaiSubscriptionConnected ? (
        <div className="flex max-w-lg flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            or connect a SuperGrok / eligible X Premium+ subscription:
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saveModelConfig.isPending}
            onClick={() => setIsXaiDialogOpen(true)}
          >
            Connect Grok subscription
          </Button>
        </div>
      ) : null}

      {isXaiProvider && !hasRuntimeProviderKey && xaiSubscriptionConnected ? (
        <span className="text-sm text-muted-foreground">
          {xaiStatus?.email
            ? `Connected as ${xaiStatus.email}`
            : 'Connected to a SuperGrok / X Premium+ account.'}
        </span>
      ) : null}

      {requiresConnectionName && !hasRuntimeProviderKey ? (
        <div className="flex max-w-lg items-center gap-2">
          <span className="w-44 shrink-0 text-sm text-muted-foreground">
            Connection name
          </span>
          <Input
            value={connectionName}
            onChange={(event) => setConnectionName(event.target.value)}
            placeholder="e.g. company-proxy"
            disabled={saveModelConfig.isPending}
            aria-label="Connection name for OpenAI-compatible endpoint"
          />
        </div>
      ) : null}

      {selectedProviderStatus?.credentialHelp &&
      !hasRuntimeProviderKey &&
      !isGitHubCopilotProvider &&
      additionalEnvFields.length === 0 ? (
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

      {isChatGptProvider && !hasRuntimeProviderKey && chatgptConnected ? (
        <span className="text-sm text-muted-foreground">
          {chatgptStatus?.email
            ? `Connected as ${chatgptStatus.email}`
            : 'Connected to a ChatGPT account.'}
        </span>
      ) : null}

      {isGitHubCopilotProvider && !hasRuntimeProviderKey ? (
        githubCopilotConnected ? (
          <span className="text-sm text-muted-foreground">
            Connected to a GitHub Copilot account.
          </span>
        ) : selectedProviderStatus?.credentialHelp &&
          additionalEnvFields.length === 0 ? (
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
        ) : null
      ) : null}

      {!hasRuntimeProviderKey &&
        additionalEnvFields.map((field) => (
          <div
            key={field.envVarName}
            className="flex max-w-lg items-center gap-2"
          >
            <span className="w-44 shrink-0 text-sm text-muted-foreground">
              {field.label}
              {field.required ? '' : ' (optional)'}
            </span>
            <AdditionalEnvFieldInput
              field={field}
              value={additionalEnvValues[field.envVarName] ?? ''}
              onValueChange={(value) =>
                setAdditionalEnvValues((values) => ({
                  ...values,
                  [field.envVarName]: value,
                }))
              }
              disabled={saveModelConfig.isPending}
              ariaLabel={`${field.label} for ${selectedProviderStatus?.label ?? 'provider'}`}
              selectTriggerClassName="min-w-44"
            />
          </div>
        ))}

      {selectedProviderStatus?.credentialHelp &&
      !hasRuntimeProviderKey &&
      additionalEnvFields.length > 0 ? (
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
      <GitHubCopilotConnectDialog
        open={isGitHubCopilotDialogOpen}
        onOpenChange={setIsGitHubCopilotDialogOpen}
        onConnected={async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.setupNew.status.queryKey(),
          });
        }}
      />
      <XaiConnectDialog
        open={isXaiDialogOpen}
        onOpenChange={setIsXaiDialogOpen}
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
          disabled={isActionDisabled}
        >
          {saveModelConfig.isPending || isCheckingEndpoint ? (
            <>
              {isCheckingEndpoint ? 'Checking connection...' : 'Saving...'}
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

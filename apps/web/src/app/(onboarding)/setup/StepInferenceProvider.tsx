'use client';

import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  getDefaultAdditionalEnvValues,
  getSetupModelProvider,
  getSetupProviderModelIdPrefixes,
  getSetupProviderTaskModelPrefix,
  getTaskModelProviderId,
  type SetupModelProviderId,
  type SetupModelStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Button,
  Check,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Input,
  Lock,
  Popover,
  PopoverContent,
  PopoverTrigger,
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

function InferenceProviderRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex md:max-w-lg flex-col gap-2 md:flex-row md:items-center">
      {children}
    </div>
  );
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
  const credentialRef = useRef<HTMLInputElement>(null);
  const [connectionName, setConnectionName] = useState('');
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >({});
  const [catalogModelQuery, setCatalogModelQuery] = useState('');
  const [selectedCatalogModelId, setSelectedCatalogModelId] = useState('');
  // Until the operator edits the field it shows the model the deployment
  // already runs, so revisiting this step does not force a new choice.
  const [catalogModelTouched, setCatalogModelTouched] = useState(false);
  const [catalogSuggestionsOpen, setCatalogSuggestionsOpen] = useState(false);
  const [highlightedCatalogSlug, setHighlightedCatalogSlug] = useState('');
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
  // SuperGrok is dual-path with the xAI API key: onboarding offers both on the
  // shared `xai` surface (and on the separate `xai-subscription` catalog id).
  const isXaiSurface =
    selectedProvider === 'xai' ||
    selectedProvider === XAI_SUBSCRIPTION_PROVIDER_ID;
  const xaiStatusQuery = useQuery(
    trpc.xaiSubscription.status.queryOptions(undefined, {
      enabled: isXaiSurface,
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
    setCatalogModelQuery('');
    setSelectedCatalogModelId('');
    setCatalogModelTouched(false);
    setCatalogSuggestionsOpen(false);
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
  const isOAuthProvider = selectedProviderStatus?.authKind === 'oauth';
  const isEndpointProvider = selectedProviderStatus?.authKind === 'endpoint';
  const requiresModelSelection =
    selectedProviderStatus?.requiresModelSelection === true;
  const providerModelIdPrefixes = useMemo(
    () =>
      selectedProviderStatus
        ? getSetupProviderModelIdPrefixes(selectedProviderStatus)
        : new Set<string>(),
    [selectedProviderStatus],
  );
  // The model the deployment already runs (saved, or supplied by the runtime
  // env) so revisiting this step does not force a new choice.
  const persistedProviderModelId = useMemo(
    () =>
      [modelSetup.persistedRoomoteModel, modelSetup.runtimeRoomoteModel].find(
        (modelId): modelId is string => {
          const prefix = modelId ? getTaskModelProviderId(modelId) : null;
          return prefix !== null && providerModelIdPrefixes.has(prefix);
        },
      ) ?? '',
    [
      modelSetup.persistedRoomoteModel,
      modelSetup.runtimeRoomoteModel,
      providerModelIdPrefixes,
    ],
  );
  const trimmedCatalogModelQuery = catalogModelQuery.trim();
  const deferredCatalogModelQuery = useDeferredValue(trimmedCatalogModelQuery);
  const catalogSuggestionsQuery = useQuery(
    trpc.taskModels.suggest.queryOptions(
      {
        providerId: selectedProvider ?? 'openrouter',
        query: deferredCatalogModelQuery,
      },
      {
        enabled: requiresModelSelection && deferredCatalogModelQuery.length > 0,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const catalogSuggestions = useMemo(
    () =>
      trimmedCatalogModelQuery.length > 0
        ? (catalogSuggestionsQuery.data?.suggestions ?? [])
        : [],
    [catalogSuggestionsQuery.data, trimmedCatalogModelQuery],
  );
  const isCatalogSearchSettled =
    deferredCatalogModelQuery === trimmedCatalogModelQuery &&
    !catalogSuggestionsQuery.isFetching;
  // The catalog is best-effort (models.dev may be unreachable or not list a
  // private model). While it offers matches the text is a search and one must
  // be picked; once it has none, the text is taken as the model id, with the
  // provider prefix added to a bare id.
  const manualModelId = useMemo(() => {
    if (
      !selectedProvider ||
      !trimmedCatalogModelQuery ||
      /\s/u.test(trimmedCatalogModelQuery)
    ) {
      return '';
    }

    const prefix = getTaskModelProviderId(trimmedCatalogModelQuery);
    if (
      trimmedCatalogModelQuery.includes('/') &&
      prefix !== null &&
      providerModelIdPrefixes.has(prefix)
    ) {
      return trimmedCatalogModelQuery.length > prefix.length + 1
        ? trimmedCatalogModelQuery
        : '';
    }

    return `${getSetupProviderTaskModelPrefix(selectedProvider)}/${trimmedCatalogModelQuery}`;
  }, [providerModelIdPrefixes, selectedProvider, trimmedCatalogModelQuery]);
  const typedModelId =
    catalogSuggestions.find(
      (suggestion) => suggestion.slug === trimmedCatalogModelQuery,
    )?.slug ??
    (isCatalogSearchSettled && catalogSuggestions.length === 0
      ? manualModelId
      : '');
  const chosenModelId = catalogModelTouched
    ? selectedCatalogModelId || typedModelId
    : persistedProviderModelId;
  const selectCatalogSuggestion = (suggestion: {
    slug: string;
    displayName: string;
  }) => {
    setSelectedCatalogModelId(suggestion.slug);
    setCatalogModelQuery(suggestion.displayName);
    setCatalogSuggestionsOpen(false);
  };
  const isCatalogListOpen =
    catalogSuggestionsOpen && trimmedCatalogModelQuery.length > 0;
  const chatgptConnected = Boolean(modelSetup.chatgptConnected);
  const githubCopilotConnected = Boolean(modelSetup.githubCopilotConnected);
  const xaiSubscriptionConnected = Boolean(
    modelSetup.xaiSubscriptionConnected || xaiStatus?.connected,
  );
  const hasRuntimeProviderKey =
    selectedProviderStatus?.runtimeApiKeySatisfied === true;
  const hasSavedProviderKey =
    selectedProviderStatus?.savedApiKeySatisfied === true;
  const primaryCredentialLabel =
    selectedProviderStatus?.envVarLabel ?? 'API key';
  const additionalEnvFields = selectedProviderStatus?.additionalEnvFields ?? [];
  // Hidden (hosting-managed) providers are never user-selectable, even when
  // connected — the catalog `hidden` flag is the single source of that rule.
  const sortedModelProviders = useMemo(
    () =>
      modelSetup.providers
        .filter((provider) => !provider.hidden)
        .sort((left, right) => left.label.localeCompare(right.label)),
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
  // SuperGrok covers the `xai` surface without an API key, same pattern as
  // ChatGPT covering openai/. Continue when either path is satisfied.
  const canContinueWithoutApiKey =
    hasRuntimeProviderKey ||
    hasSavedProviderKey ||
    (isXaiSurface && xaiSubscriptionConnected) ||
    (isChatGptProvider && chatgptConnected) ||
    (isGitHubCopilotProvider && githubCopilotConnected);
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
    (requiresModelSelection && !chosenModelId) ||
    (!canContinueWithoutApiKey && apiKey.trim().length === 0);
  const isCheckingEndpoint =
    isEndpointProvider &&
    (discoverProviderModels.isPending || qualifyProviderModel.isPending);

  const handleContinue = async () => {
    if (!selectedProvider) {
      return;
    }

    let modelId = requiresModelSelection ? chosenModelId : undefined;
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
      <div className="space-y-2">
        <p>
          Roomote needs a model provider for, you know, AI stuff. Popular
          choices are ChatGPT subscriptions and OpenRouter.
        </p>
        <p className="text-sm text-foreground/50">
          <Lock className="inline size-3 mr-1" />
          Credentials are encrypted in your database.
        </p>
      </div>

      <div className="w-full space-y-2">
        <InferenceProviderRow>
          <Select
            value={selectedProvider ?? undefined}
            handoffTargetOnSelect={credentialRef}
            onValueChange={(value) =>
              selectProvider(value as SetupModelProviderId)
            }
          >
            <SelectTrigger
              aria-label="Model provider"
              className="min-w-44 w-full md:w-auto"
            >
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
              ref={credentialRef}
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

          {isXaiSurface &&
          !hasRuntimeProviderKey &&
          !xaiSubscriptionConnected ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={saveModelConfig.isPending}
              onClick={() => setIsXaiDialogOpen(true)}
            >
              Connect Grok subscription
            </Button>
          ) : null}

          {(hasRuntimeProviderKey ||
            hasSavedProviderKey ||
            (isXaiSurface && xaiSubscriptionConnected)) && <Check />}
        </InferenceProviderRow>

        {isXaiSurface && !hasRuntimeProviderKey && xaiSubscriptionConnected ? (
          <span className="text-sm text-muted-foreground">
            {xaiStatus?.email
              ? `Connected as ${xaiStatus.email}`
              : 'Connected to a SuperGrok / X Premium+ account.'}
          </span>
        ) : null}

        {requiresConnectionName && !hasRuntimeProviderKey ? (
          <InferenceProviderRow>
            <span className="w-44 shrink-0 text-sm text-muted-foreground">
              What to call this
            </span>
            <Input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder="e.g. Internal Provider"
              disabled={saveModelConfig.isPending}
              aria-label="Connection name for OpenAI-compatible endpoint"
            />
          </InferenceProviderRow>
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
            <InferenceProviderRow key={field.envVarName}>
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
            </InferenceProviderRow>
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

        {requiresModelSelection ? (
          <InferenceProviderRow>
            <span className="w-44 shrink-0 text-sm text-muted-foreground">
              Model
            </span>
            <Popover
              open={isCatalogListOpen}
              onOpenChange={setCatalogSuggestionsOpen}
            >
              {/* The input anchors the list; clicking into it must not
                  toggle the popover closed. */}
              <PopoverTrigger
                asChild
                onClick={(event) => event.preventDefault()}
              >
                <div className="w-full">
                  <Input
                    value={
                      catalogModelTouched
                        ? catalogModelQuery
                        : persistedProviderModelId
                    }
                    onChange={(event) => {
                      setCatalogModelTouched(true);
                      setCatalogModelQuery(event.target.value);
                      setSelectedCatalogModelId('');
                      setHighlightedCatalogSlug('');
                      setCatalogSuggestionsOpen(true);
                    }}
                    // Focus stays in the input while the list is open, so the
                    // list is driven from here.
                    onKeyDown={(event) => {
                      if (!isCatalogListOpen) {
                        return;
                      }
                      if (event.key === 'Escape') {
                        setCatalogSuggestionsOpen(false);
                        return;
                      }
                      if (catalogSuggestions.length === 0) {
                        return;
                      }
                      const highlightedIndex = catalogSuggestions.findIndex(
                        (suggestion) =>
                          suggestion.slug === highlightedCatalogSlug,
                      );
                      if (
                        event.key === 'ArrowDown' ||
                        event.key === 'ArrowUp'
                      ) {
                        event.preventDefault();
                        const step = event.key === 'ArrowDown' ? 1 : -1;
                        const nextIndex =
                          highlightedIndex === -1 && step === -1
                            ? catalogSuggestions.length - 1
                            : (highlightedIndex +
                                step +
                                catalogSuggestions.length) %
                              catalogSuggestions.length;
                        setHighlightedCatalogSlug(
                          catalogSuggestions[nextIndex]!.slug,
                        );
                      } else if (
                        event.key === 'Enter' &&
                        highlightedIndex >= 0
                      ) {
                        event.preventDefault();
                        selectCatalogSuggestion(
                          catalogSuggestions[highlightedIndex]!,
                        );
                      }
                    }}
                    placeholder="Search or enter a model ID"
                    role="combobox"
                    aria-expanded={isCatalogListOpen}
                    aria-autocomplete="list"
                    aria-label={`${selectedProviderStatus?.label ?? 'Provider'} model`}
                    disabled={saveModelConfig.isPending}
                  />
                </div>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-(--radix-popover-trigger-width) p-0"
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <Command
                  shouldFilter={false}
                  value={highlightedCatalogSlug}
                  onValueChange={setHighlightedCatalogSlug}
                >
                  <CommandList>
                    <CommandEmpty>
                      {!isCatalogSearchSettled
                        ? 'Searching the catalog...'
                        : typedModelId
                          ? `No catalog match. Continue to use ${typedModelId} as entered.`
                          : 'No catalog models found.'}
                    </CommandEmpty>
                    {catalogSuggestions.length > 0 ? (
                      <CommandGroup>
                        {catalogSuggestions.map((suggestion) => (
                          <CommandItem
                            key={suggestion.slug}
                            value={suggestion.slug}
                            onSelect={() => selectCatalogSuggestion(suggestion)}
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {suggestion.displayName}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {suggestion.slug}
                              </p>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </InferenceProviderRow>
        ) : null}

        {selectedProvider === 'openrouter' && !hasRuntimeProviderKey && (
          <InferenceProviderRow>
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
          </InferenceProviderRow>
        )}
      </div>

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

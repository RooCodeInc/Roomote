'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  SETUP_MODEL_PROVIDER_CATALOG,
  type SetupModelProviderId,
  type SetupModelStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Button,
  Check,
  EnvVarsInfoNote,
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
}: {
  modelSetup: SetupModelStatus;
  openRouterOauthStatus?: OpenRouterOauthEntryStatus | null;
  openRouterOauthErrorReason?: string | null;
  onContinue: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] =
    useState<SetupModelProviderId>(modelSetup.preselectedProvider);
  const [apiKey, setApiKey] = useState('');
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >({});
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

  useEffect(() => {
    setSelectedProvider(modelSetup.preselectedProvider);
  }, [modelSetup.preselectedProvider]);

  useEffect(() => {
    setApiKey('');
    setAdditionalEnvValues({});
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
  const chatgptConnected = Boolean(modelSetup.chatgptConnected);
  const hasRuntimeProviderKey =
    selectedProviderStatus?.runtimeApiKeySatisfied === true;
  const hasSavedProviderKey =
    selectedProviderStatus?.savedApiKeySatisfied === true;
  const primaryCredentialLabel =
    selectedProviderStatus?.envVarLabel ?? 'API key';
  const additionalEnvFields = selectedProviderStatus?.additionalEnvFields ?? [];
  const sortedModelProviderCatalog = useMemo(
    () =>
      [...SETUP_MODEL_PROVIDER_CATALOG].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [],
  );
  const shouldShowSavedValueMask =
    !hasRuntimeProviderKey &&
    hasSavedProviderKey &&
    apiKey.length === 0 &&
    !editingSavedValue;
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
    await saveModelConfig.mutateAsync({
      provider: selectedProvider,
      apiKey: apiKey.trim() || undefined,
      ...(additionalEnvFields.length > 0 && { additionalEnvValues }),
    });
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
            {sortedModelProviderCatalog.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isChatGptProvider ? null : (
          <Input
            secret={!hasRuntimeProviderKey}
            value={
              hasRuntimeProviderKey
                ? ''
                : shouldShowSavedValueMask
                  ? MASKED_VALUE
                  : apiKey
            }
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

      <div className="space-y-2 text-sm text-muted-foreground">
        <EnvVarsInfoNote>
          You can pass keys in as ENV vars when running Roomote (highly
          recommended in production). When configured here, they&apos;re
          encrypted in the database.
        </EnvVarsInfoNote>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={isActionDisabled}
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
      </div>
    </div>
  );
}

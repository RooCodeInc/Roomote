'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ROOMOTE_INFERENCE_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  getDefaultAdditionalEnvValues,
  getModelProviderLabel,
  isApiKeySubscriptionUsageProviderId,
} from '@roomote/types';
import type {
  ProviderCreditBalance,
  ProviderCreditBalanceProviderId,
  SetupModelProviderId,
  SetupModelProviderStatus,
  SetupModelStatus,
  SubscriptionProviderUsage,
  SubscriptionUsageProviderId,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  BasicTooltip,
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Switch,
  Trash2,
} from '@/components/system';
import { Section } from '@/components/settings/Section';
import { AdditionalEnvFieldInput } from '@/components/settings/AdditionalEnvFieldInput';
import { ChatGptConnectDialog } from '@/components/settings/ChatGptConnectDialog';
import { GitHubCopilotConnectDialog } from '@/components/settings/GitHubCopilotConnectDialog';
import { XaiConnectDialog } from '@/components/settings/XaiConnectDialog';
import { ProviderCreditBalanceLine } from '@/components/settings/ProviderCreditBalanceLine';
import { SubscriptionUsageLine } from '@/components/settings/SubscriptionUsageLine';
import { Secret } from 'modal';

const MASKED_VALUE = '••••••••••••••••••••••••••••';
const PROVIDER_GRID_ROW_CLASS =
  'grid gap-2 md:grid-cols-[minmax(160px,220px)_minmax(0,1fr)]';

type InferenceProviderSectionProps = {
  providerSetup: SetupModelStatus | null;
  providerSetupPending: boolean;
  connectedProviders: SetupModelProviderStatus[];
  availableProviders: SetupModelProviderStatus[];
  /**
   * Called after connecting a provider auto-added its recommended models,
   * so the page can bring the refreshed model list into view.
   */
  onRecommendedModelsAdded?: () => void;
};

type ProviderCredentialsDialogState =
  | { mode: 'add'; providerId?: SetupModelProviderId }
  | { mode: 'edit'; providerId: SetupModelProviderId };

function getInitialAdditionalEnvValues(
  provider: SetupModelProviderStatus | null,
) {
  if (!provider) {
    return {};
  }

  // Endpoint providers expose the primary base URL in additionalEnvValues for
  // list display, but save only accepts declared additional fields.
  const declaredNames = new Set(
    (provider.additionalEnvFields ?? []).map((field) => field.envVarName),
  );

  const values = Object.fromEntries(
    Object.entries(provider.additionalEnvValues ?? {}).filter(([name]) =>
      declaredNames.has(name),
    ),
  );

  return getDefaultAdditionalEnvValues(
    provider.additionalEnvFields ?? [],
    values,
  );
}

function getInitialPrimaryCredential(
  provider: SetupModelProviderStatus | null,
) {
  if (provider?.authKind !== 'endpoint' || !provider.envVarName) {
    return '';
  }

  return provider.additionalEnvValues[provider.envVarName] ?? '';
}

function getSubmitAdditionalEnvValues(
  provider: SetupModelProviderStatus,
  additionalEnvValues: Record<string, string>,
) {
  const additionalEnvFields = provider.additionalEnvFields ?? [];
  if (additionalEnvFields.length === 0) {
    return undefined;
  }

  const declaredNames = new Set(
    additionalEnvFields.map((field) => field.envVarName),
  );

  const values = Object.fromEntries(
    Object.entries(additionalEnvValues).filter(([name]) =>
      declaredNames.has(name),
    ),
  );

  return getDefaultAdditionalEnvValues(additionalEnvFields, values);
}

function ConnectedProviderRow({
  provider,
  usage,
  creditBalance,
  isSaving,
  canDelete,
  onEdit,
  onDelete,
}: {
  provider: SetupModelProviderStatus;
  usage?: SubscriptionProviderUsage;
  creditBalance?: ProviderCreditBalance;
  isSaving: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  if (provider.id === ROOMOTE_INFERENCE_PROVIDER_ID) {
    return (
      <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
        <span className="min-w-0 truncate text-sm font-medium">
          {provider.label}
        </span>
        <div>
          <p className="text-sm text-muted-foreground mb-2">
            Managed by Roomote with free trial credits. Add your own provider at
            any time to continue after credits end.
          </p>
          <ProviderCreditBalanceLine
            balance={creditBalance}
            className="max-w-md"
          />
        </div>
      </div>
    );
  }

  const hasRuntimeKey = provider.runtimeApiKeySatisfied;
  const primaryCredentialLabel = provider.envVarLabel ?? 'API key';
  const runtimeKeyTooltip = provider.envVarName
    ? `Set by ${provider.envVarName}, not changeable in the UI.`
    : 'Set by an environment variable, not changeable in the UI.';
  const runtimeKeyLabel = provider.envVarName
    ? `${provider.label} API key is managed by ${provider.envVarName}`
    : `${provider.label} API key is managed by an environment variable`;
  const inputValue =
    provider.authKind === 'endpoint'
      ? (provider.additionalEnvValues[provider.envVarName ?? ''] ??
        'Configured endpoint')
      : MASKED_VALUE;

  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <div className="flex min-w-0 gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {provider.label}
        </span>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="w-full max-w-md">
          <SubscriptionUsageLine usage={usage} className="mt-1" />
          <ProviderCreditBalanceLine balance={creditBalance} className="mt-2" />
        </div>

        {hasRuntimeKey ? (
          <BasicTooltip content={runtimeKeyTooltip}>
            <Lock
              aria-label={runtimeKeyLabel}
              className="mr-1.5 size-4 text-muted-foreground"
            />
          </BasicTooltip>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <BasicTooltip content={`Edit ${provider.label}`}>
              <Button
                size="icon"
                variant="ghost"
                onClick={onEdit}
                disabled={isSaving}
                aria-label={`Edit ${provider.label} ${primaryCredentialLabel}`}
              >
                {isSaving ? <Spinner /> : <Pencil />}
              </Button>
            </BasicTooltip>
            <BasicTooltip
              content={
                canDelete
                  ? `Delete ${provider.label}`
                  : 'Keep at least one inference provider connected'
              }
            >
              <span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onDelete}
                  disabled={isSaving || !canDelete}
                  aria-label={`Delete ${provider.label} provider`}
                >
                  <Trash2 />
                </Button>
              </span>
            </BasicTooltip>
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCredentialsDialog({
  open,
  mode,
  providers,
  isSaving,
  onSave,
  onOpenChange,
  onConnectOAuth,
}: {
  open: boolean;
  mode: 'add' | 'edit';
  providers: SetupModelProviderStatus[];
  isSaving: boolean;
  onSave: (
    providerId: SetupModelProviderId,
    apiKey: string,
    additionalEnvValues?: Record<string, string>,
    connectionName?: string,
  ) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onConnectOAuth: (providerId: SetupModelProviderId) => void;
}) {
  const [selectedProviderId, setSelectedProviderId] =
    useState<SetupModelProviderId | null>(providers[0]?.id ?? null);
  const [apiKey, setApiKey] = useState(() =>
    getInitialPrimaryCredential(providers[0] ?? null),
  );
  const [connectionName, setConnectionName] = useState('');
  const [providerSelectOpen, setProviderSelectOpen] = useState(false);
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >(() => getInitialAdditionalEnvValues(providers[0] ?? null));

  useEffect(() => {
    if (!open) {
      return;
    }

    if (
      selectedProviderId &&
      providers.some((provider) => provider.id === selectedProviderId)
    ) {
      return;
    }

    // Saving an endpoint provider refreshes its metadata and replaces the
    // provider objects passed to this dialog. Keep the current selection and
    // form values when that happens; otherwise the refresh clears the endpoint
    // while model discovery is in flight and repeatedly reinitializes the
    // dialog. Only initialize values when the selection is no longer valid.
    const provider = providers[0] ?? null;
    setSelectedProviderId(provider?.id ?? null);
    setApiKey(getInitialPrimaryCredential(provider));
    setConnectionName('');
    setAdditionalEnvValues(getInitialAdditionalEnvValues(provider));
  }, [open, providers, selectedProviderId]);

  useEffect(() => {
    if (!open || mode !== 'add') {
      setProviderSelectOpen(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setProviderSelectOpen(true);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [mode, open]);

  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0] ??
    null;

  const primaryCredentialLabel = selectedProvider?.envVarLabel ?? 'API key';
  const additionalEnvFields = selectedProvider?.additionalEnvFields ?? [];
  const hasMissingRequiredFields = additionalEnvFields.some(
    (field) =>
      field.required &&
      (additionalEnvValues[field.envVarName]?.trim() ?? '').length === 0,
  );
  const hasExistingPrimaryCredential = Boolean(
    mode === 'edit' &&
    selectedProvider &&
    (selectedProvider.savedApiKeySatisfied ||
      selectedProvider.runtimeApiKeySatisfied),
  );
  const hasMissingPrimaryCredential =
    !hasExistingPrimaryCredential && apiKey.trim().length === 0;

  const requiresConnectionName =
    mode === 'add' &&
    (selectedProvider?.id === OPENAI_COMPATIBLE_PROVIDER_ID ||
      selectedProvider?.allowMultipleConnections === true);
  const hasMissingConnectionName =
    requiresConnectionName && connectionName.trim().length === 0;

  const handleSaveClick = async () => {
    if (!selectedProvider) {
      return;
    }

    try {
      await onSave(
        selectedProvider.id,
        apiKey.trim(),
        getSubmitAdditionalEnvValues(selectedProvider, additionalEnvValues),
        requiresConnectionName ? connectionName.trim() : undefined,
      );
      setApiKey('');
      setConnectionName('');
      setAdditionalEnvValues({});
    } catch {
      // The mutation surfaces failures via toast; keep the typed key so the
      // user can retry without re-entering it.
    }
  };

  const isChatGptProvider =
    selectedProvider?.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID;
  const isGitHubCopilotProvider = selectedProvider?.id === 'github-copilot';
  const isXaiSubscriptionProvider =
    selectedProvider?.id === XAI_SUBSCRIPTION_PROVIDER_ID;
  const isOAuthProvider = selectedProvider?.authKind === 'oauth';
  const oauthAccountDescription = isChatGptProvider
    ? 'Connect a ChatGPT Plus or Pro account to run tasks on your subscription.'
    : isGitHubCopilotProvider
      ? 'Connect a GitHub account with an active Copilot plan.'
      : isXaiSubscriptionProvider
        ? 'Connect a SuperGrok or eligible X Premium+ account to run Grok models on your subscription.'
        : 'Connect your subscription account.';
  const oauthConnectButtonLabel = isGitHubCopilotProvider
    ? 'Connect GitHub Copilot'
    : isXaiSubscriptionProvider
      ? 'Connect Grok subscription'
      : 'Connect ChatGPT';
  const title =
    mode === 'add'
      ? 'Add Provider'
      : `Edit ${selectedProvider?.label ?? 'Provider'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === 'add'
              ? 'Connect a provider for model inference.'
              : 'Update the saved provider credentials.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {selectedProvider ? (
            <>
              <div className={PROVIDER_GRID_ROW_CLASS}>
                <span className="text-sm font-medium">Provider</span>
                <Select
                  open={providerSelectOpen}
                  onOpenChange={setProviderSelectOpen}
                  value={selectedProvider.id}
                  onValueChange={(value) => {
                    const providerId = value as SetupModelProviderId;
                    const provider =
                      providers.find(
                        (candidate) => candidate.id === providerId,
                      ) ?? null;
                    setSelectedProviderId(providerId);
                    setApiKey(getInitialPrimaryCredential(provider));
                    setConnectionName('');
                    setAdditionalEnvValues(
                      getInitialAdditionalEnvValues(provider),
                    );
                  }}
                  disabled={isSaving || mode === 'edit'}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={mode === 'add' ? 'Provider to add' : 'Provider'}
                  >
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isOAuthProvider ? (
                <div className={PROVIDER_GRID_ROW_CLASS}>
                  <span className="text-sm font-medium">Account</span>
                  <p className="min-w-0 text-sm text-muted-foreground">
                    {oauthAccountDescription}
                  </p>
                </div>
              ) : (
                <>
                  {requiresConnectionName ? (
                    <div className={PROVIDER_GRID_ROW_CLASS}>
                      <span className="text-sm font-medium">
                        Connection name
                      </span>
                      <div className="space-y-1.5">
                        <Input
                          value={connectionName}
                          onChange={(event) =>
                            setConnectionName(event.target.value)
                          }
                          placeholder="e.g. company-proxy"
                          disabled={isSaving}
                          aria-label="Connection name for OpenAI-compatible endpoint"
                        />
                        <p className="text-xs text-muted-foreground">
                          A short label for this endpoint in Models settings.
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div className={PROVIDER_GRID_ROW_CLASS}>
                    <span className="text-sm font-medium">
                      {primaryCredentialLabel}
                    </span>
                    <div className="space-y-1.5">
                      <Input
                        type={
                          selectedProvider.authKind === 'endpoint'
                            ? 'url'
                            : undefined
                        }
                        inputMode={
                          selectedProvider.authKind === 'endpoint'
                            ? 'url'
                            : undefined
                        }
                        autoComplete={
                          selectedProvider.authKind === 'endpoint'
                            ? 'url'
                            : undefined
                        }
                        secret={selectedProvider.authKind !== 'endpoint'}
                        className="font-mono"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={`${primaryCredentialLabel} for ${selectedProvider.label}`}
                        disabled={isSaving}
                        aria-label={`${mode === 'edit' ? 'New ' : ''}${primaryCredentialLabel} for ${selectedProvider.label}`}
                        data-1p-ignore
                      />
                      {selectedProvider.credentialHelp ? (
                        <p className="text-xs text-muted-foreground">
                          {selectedProvider.credentialHelp.text}{' '}
                          <a
                            className="font-medium underline underline-offset-2 hover:text-foreground"
                            href={selectedProvider.credentialHelp.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {selectedProvider.credentialHelp.linkLabel}
                          </a>
                          .
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {additionalEnvFields.map((field) => (
                    <div
                      key={field.envVarName}
                      className={PROVIDER_GRID_ROW_CLASS}
                    >
                      <span className="text-sm font-medium">
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
                        disabled={isSaving}
                        ariaLabel={`${field.label} for ${selectedProvider.label}`}
                        inputClassName={field.secret ? 'font-mono' : undefined}
                      />
                    </div>
                  ))}
                </>
              )}
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          {isOAuthProvider ? (
            <Button
              size="sm"
              onClick={() =>
                selectedProvider && onConnectOAuth(selectedProvider.id)
              }
              disabled={isSaving || !selectedProvider}
            >
              {oauthConnectButtonLabel}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void handleSaveClick()}
              disabled={
                isSaving ||
                !selectedProvider ||
                hasMissingPrimaryCredential ||
                hasMissingRequiredFields ||
                hasMissingConnectionName
              }
            >
              {isSaving ? (
                <Spinner />
              ) : (
                <>
                  <Check />
                  {mode === 'add' ? 'Add' : 'Save'}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatGptSubscriptionRow({
  errored,
  accountEmail,
  errorMessage,
  usage,
  fastMode,
  onFastModeChange,
  isUpdatingFastMode,
  onReconnect,
  onDisconnect,
  isDisconnecting,
}: {
  errored: boolean;
  accountEmail?: string;
  errorMessage?: string;
  usage?: SubscriptionProviderUsage;
  fastMode: boolean;
  onFastModeChange: (enabled: boolean) => Promise<void>;
  isUpdatingFastMode: boolean;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  isDisconnecting: boolean;
}) {
  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {getModelProviderLabel(CHATGPT_SUBSCRIPTION_PROVIDER_ID)}
        </span>
        <BasicTooltip content="Uses more ChatGPT credits for faster responses.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Fast mode</span>
            <Switch
              aria-label="ChatGPT fast mode"
              checked={fastMode}
              disabled={errored || isUpdatingFastMode}
              onCheckedChange={(checked) =>
                void onFastModeChange(checked === true)
              }
            />
          </div>
        </BasicTooltip>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          {errored ? (
            <p className="min-w-0 truncate text-sm text-destructive">
              {errorMessage ?? 'ChatGPT subscription needs to be reconnected.'}
            </p>
          ) : (
            <p className="min-w-0 truncate text-sm text-muted-foreground">
              {accountEmail
                ? `Connected as ${accountEmail}`
                : 'Connected to a ChatGPT account.'}
            </p>
          )}
          {!errored ? (
            <SubscriptionUsageLine usage={usage} className="mt-1 max-w-md" />
          ) : null}
        </div>

        <SubscriptionProviderActions
          providerLabel={getModelProviderLabel(
            CHATGPT_SUBSCRIPTION_PROVIDER_ID,
          )}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
          isDisconnecting={isDisconnecting}
        />
      </div>
    </div>
  );
}

function SubscriptionProviderActions({
  providerLabel,
  onReconnect,
  onDisconnect,
  isDisconnecting,
}: {
  providerLabel: string;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  isDisconnecting: boolean;
}) {
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1">
      <BasicTooltip content={`Reconnect ${providerLabel}`}>
        <Button
          size="icon"
          variant="ghost"
          onClick={onReconnect}
          disabled={isDisconnecting}
          aria-label={`Reconnect ${providerLabel}`}
        >
          <Pencil />
        </Button>
      </BasicTooltip>
      <BasicTooltip content={`Disconnect ${providerLabel}`}>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void onDisconnect()}
          disabled={isDisconnecting}
          aria-label={`Disconnect ${providerLabel}`}
        >
          {isDisconnecting ? <Spinner /> : <Trash2 />}
        </Button>
      </BasicTooltip>
    </div>
  );
}

function XaiSubscriptionRow({
  errored,
  accountEmail,
  errorMessage,
  usage,
  onReconnect,
  onDisconnect,
  isDisconnecting,
}: {
  errored: boolean;
  accountEmail?: string;
  errorMessage?: string;
  usage?: SubscriptionProviderUsage;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  isDisconnecting: boolean;
}) {
  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <span className="min-w-0 truncate text-sm font-medium">
        {getModelProviderLabel(XAI_SUBSCRIPTION_PROVIDER_ID)}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p
            className={`min-w-0 truncate text-sm ${errored ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {errored
              ? (errorMessage ??
                'xAI Grok subscription needs to be reconnected.')
              : accountEmail
                ? `Connected as ${accountEmail}`
                : 'Connected to a SuperGrok / X Premium+ account.'}
          </p>
          {!errored ? (
            <SubscriptionUsageLine usage={usage} className="mt-1 max-w-md" />
          ) : null}
        </div>
        <SubscriptionProviderActions
          providerLabel={getModelProviderLabel(XAI_SUBSCRIPTION_PROVIDER_ID)}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
          isDisconnecting={isDisconnecting}
        />
      </div>
    </div>
  );
}

function GitHubCopilotSubscriptionRow({
  errored,
  errorMessage,
  usage,
  onReconnect,
  onDisconnect,
  isDisconnecting,
}: {
  errored: boolean;
  errorMessage?: string;
  usage?: SubscriptionProviderUsage;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  isDisconnecting: boolean;
}) {
  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <span className="min-w-0 truncate text-sm font-medium">
        {getModelProviderLabel('github-copilot')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p
            className={`min-w-0 truncate text-sm ${errored ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {errored
              ? (errorMessage ?? 'GitHub Copilot needs to be reconnected.')
              : 'Connected to a GitHub Copilot account.'}
          </p>
          {!errored ? (
            <SubscriptionUsageLine usage={usage} className="mt-1 max-w-md" />
          ) : null}
        </div>
        <SubscriptionProviderActions
          providerLabel={getModelProviderLabel('github-copilot')}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
          isDisconnecting={isDisconnecting}
        />
      </div>
    </div>
  );
}

function DeleteProviderDialog({
  provider,
  open,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  provider: SetupModelProviderStatus | null;
  open: boolean;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Delete {provider?.label ?? 'Provider'}?</DialogTitle>
          <DialogDescription>
            This removes the saved provider credentials and deletes configured
            models for this provider from the model mapping list. Existing task
            inference usage and provider usage analytics are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={!provider || isDeleting}
          >
            {isDeleting ? <Spinner /> : <Trash2 />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InferenceProviderSection({
  providerSetup,
  providerSetupPending,
  connectedProviders,
  availableProviders,
  onRecommendedModelsAdded,
}: InferenceProviderSectionProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [savingProviderId, setSavingProviderId] =
    useState<SetupModelProviderId | null>(null);
  const [providerDialog, setProviderDialog] =
    useState<ProviderCredentialsDialogState | null>(null);
  const [deleteProviderId, setDeleteProviderId] =
    useState<SetupModelProviderId | null>(null);
  const [isChatGptDialogOpen, setIsChatGptDialogOpen] = useState(false);
  const [isGitHubCopilotDialogOpen, setIsGitHubCopilotDialogOpen] =
    useState(false);
  const [isXaiDialogOpen, setIsXaiDialogOpen] = useState(false);

  const chatgptStatusQuery = useQuery(
    trpc.chatgptSubscription.status.queryOptions(),
  );
  const chatgptStatus = chatgptStatusQuery.data ?? null;
  const githubCopilotStatusQuery = useQuery(
    trpc.githubCopilotSubscription.status.queryOptions(),
  );
  const githubCopilotStatus = githubCopilotStatusQuery.data ?? null;
  const xaiStatusQuery = useQuery(trpc.xaiSubscription.status.queryOptions());
  const xaiStatus = xaiStatusQuery.data ?? null;

  // Usage endpoints are unofficial upstream surfaces; a provider missing from
  // the result just means no usage line is rendered for it.
  const subscriptionUsageQuery = useQuery(
    trpc.subscriptionUsage.list.queryOptions(undefined, {
      staleTime: 60_000,
    }),
  );
  const usageByProvider = useMemo(
    () =>
      new Map<SubscriptionUsageProviderId, SubscriptionProviderUsage>(
        (subscriptionUsageQuery.data ?? []).map((usage) => [
          usage.providerId,
          usage,
        ]),
      ),
    [subscriptionUsageQuery.data],
  );

  // Credit-balance endpoints soft-fail the same way: missing means no line.
  const providerCreditsQuery = useQuery(
    trpc.providerCredits.list.queryOptions(undefined, {
      staleTime: 60_000,
    }),
  );
  const creditBalanceByProvider = useMemo(
    () =>
      new Map<ProviderCreditBalanceProviderId, ProviderCreditBalance>(
        (providerCreditsQuery.data ?? []).map((balance) => [
          balance.providerId,
          balance,
        ]),
      ),
    [providerCreditsQuery.data],
  );

  const saveProvider = useMutation(
    trpc.taskModels.saveProvider.mutationOptions({
      onSuccess: async (result, variables) => {
        const providerLabel = getModelProviderLabel(variables.provider);
        const addedModelCount = result.addedRecommendedModelCount;
        const addedDiscoveredModelCount = result.addedDiscoveredModelCount;

        toast.success(
          addedDiscoveredModelCount > 0
            ? `Saved the ${providerLabel} API key and made ${addedDiscoveredModelCount} discovered ${addedDiscoveredModelCount === 1 ? 'model' : 'models'} available.`
            : addedModelCount > 0
              ? `Saved the ${providerLabel} API key and added ${addedModelCount} recommended ${addedModelCount === 1 ? 'model' : 'models'}.`
              : `Saved the ${providerLabel} API key.`,
        );
        setProviderDialog(null);
        if (result.discoveryError) {
          toast.error(result.discoveryError);
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.subscriptionUsage.list.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.providerCredits.list.queryKey(),
          }),
          ...(addedModelCount > 0 || addedDiscoveredModelCount > 0
            ? [
                queryClient.invalidateQueries({
                  queryKey: trpc.taskModels.get.queryKey(),
                }),
                queryClient.invalidateQueries({
                  queryKey: trpc.taskModels.launchOptions.queryKey(),
                }),
              ]
            : []),
        ]);

        if (addedModelCount > 0 || addedDiscoveredModelCount > 0) {
          onRecommendedModelsAdded?.();
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
      onSettled: () => {
        setSavingProviderId(null);
      },
    }),
  );

  const disconnectChatGpt = useMutation(
    trpc.chatgptSubscription.disconnect.mutationOptions({
      onSuccess: async () => {
        toast.success('Disconnected ChatGPT subscription.');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.launchOptions.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.chatgptSubscription.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.subscriptionUsage.list.queryKey(),
          }),
        ]);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const updateChatGptFastMode = useMutation(
    trpc.chatgptSubscription.updateFastMode.mutationOptions({
      onSuccess: async (_result, variables) => {
        toast.success(
          variables.fastMode
            ? 'Enabled ChatGPT fast mode.'
            : 'Disabled ChatGPT fast mode.',
        );
        await queryClient.invalidateQueries({
          queryKey: trpc.chatgptSubscription.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const disconnectGitHubCopilot = useMutation(
    trpc.githubCopilotSubscription.disconnect.mutationOptions({
      onSuccess: async () => {
        toast.success('Disconnected GitHub Copilot subscription.');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.launchOptions.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.githubCopilotSubscription.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.subscriptionUsage.list.queryKey(),
          }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const disconnectXai = useMutation(
    trpc.xaiSubscription.disconnect.mutationOptions({
      onSuccess: async () => {
        toast.success('Disconnected xAI Grok subscription.');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.launchOptions.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.xaiSubscription.status.queryKey(),
          }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deleteProvider = useMutation(
    trpc.taskModels.deleteProvider.mutationOptions({
      onSuccess: async (_result, variables) => {
        toast.success(
          `Deleted the ${getModelProviderLabel(variables.provider)} provider.`,
        );
        setDeleteProviderId(null);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.get.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.launchOptions.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.subscriptionUsage.list.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.providerCredits.list.queryKey(),
          }),
        ]);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handleSave = async (
    providerId: SetupModelProviderId,
    apiKey: string,
    additionalEnvValues?: Record<string, string>,
    connectionName?: string,
  ) => {
    setSavingProviderId(providerId);
    await saveProvider.mutateAsync({
      provider: providerId,
      ...(apiKey && { apiKey }),
      ...(additionalEnvValues && { additionalEnvValues }),
      ...(connectionName && { connectionName }),
    });
  };

  const handleDisconnectChatGpt = async () => {
    await disconnectChatGpt.mutateAsync();
  };
  const handleChatGptFastModeChange = async (fastMode: boolean) => {
    await updateChatGptFastMode.mutateAsync({ fastMode });
  };
  const handleDisconnectGitHubCopilot = async () => {
    await disconnectGitHubCopilot.mutateAsync();
  };
  const handleDisconnectXai = async () => {
    await disconnectXai.mutateAsync();
  };

  const handleDeleteProvider = async () => {
    if (!deleteProviderId) {
      return;
    }

    await deleteProvider.mutateAsync({ provider: deleteProviderId });
  };

  // Drive the ChatGPT row's connected/errored/reconnect states from a single
  // source. `chatgptStatus.status` is 'connected' or 'error' when a record
  // exists, so a record exists iff status is one of those. The earlier check
  // mixed `providerSetup.chatgptConnected` (true only when status==='connected')
  // with `chatgptStatus.status==='error'`, which were mutually exclusive and
  // made the Reconnect/Disconnect branch unreachable for an errored record.
  // While the status query is still loading, fall back to the provider-setup
  // flag so a connected subscription does not flash as addable.
  const chatgptHasRecord =
    chatgptStatus?.status === 'connected' ||
    chatgptStatus?.status === 'error' ||
    (chatgptStatusQuery.isPending && Boolean(providerSetup?.chatgptConnected));
  const chatgptErrored = chatgptStatus?.status === 'error';
  const githubCopilotHasRecord =
    githubCopilotStatus?.status === 'connected' ||
    githubCopilotStatus?.status === 'error' ||
    (githubCopilotStatusQuery.isPending &&
      Boolean(providerSetup?.githubCopilotConnected));
  const githubCopilotErrored = githubCopilotStatus?.status === 'error';
  const xaiHasRecord =
    xaiStatus?.status === 'connected' ||
    xaiStatus?.status === 'error' ||
    (xaiStatusQuery.isPending &&
      Boolean(providerSetup?.xaiSubscriptionConnected));
  const xaiErrored = xaiStatus?.status === 'error';
  const xaiHasApiKey = Boolean(providerSetup?.xaiApiKeyConnected);

  // Subscription oauth rows are rendered separately; API-key xAI stays in the
  // key list and can coexist with the SuperGrok subscription provider.
  const apiKeyConnectedProviders = connectedProviders.filter((provider) => {
    if (
      provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID ||
      provider.id === 'github-copilot' ||
      provider.id === XAI_SUBSCRIPTION_PROVIDER_ID
    ) {
      return false;
    }
    return true;
  });
  const addableProviders = availableProviders.filter((provider) => {
    if (provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID) {
      return !chatgptHasRecord;
    }
    if (provider.id === 'github-copilot') {
      return !githubCopilotHasRecord;
    }
    if (provider.id === XAI_SUBSCRIPTION_PROVIDER_ID) {
      return !xaiHasRecord;
    }
    if (provider.id === 'xai') {
      return !xaiHasApiKey;
    }
    return provider.authKind === 'api-key' || provider.authKind === 'endpoint';
  });
  const sortedApiKeyConnectedProviders = useMemo(
    () =>
      [...apiKeyConnectedProviders].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [apiKeyConnectedProviders],
  );
  const sortedAddableProviders = useMemo(
    () =>
      [...addableProviders].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [addableProviders],
  );
  const providerDialogProviders = useMemo(() => {
    if (!providerDialog) {
      return [];
    }

    if (providerDialog.mode === 'add') {
      if (providerDialog.providerId) {
        const savedProvider = providerSetup?.providers.find(
          (provider) => provider.id === providerDialog.providerId,
        );

        return savedProvider ? [savedProvider] : [];
      }

      return sortedAddableProviders;
    }

    const editProvider = sortedApiKeyConnectedProviders.find(
      (provider) => provider.id === providerDialog.providerId,
    );

    return editProvider ? [editProvider] : [];
  }, [
    providerDialog,
    providerSetup?.providers,
    sortedAddableProviders,
    sortedApiKeyConnectedProviders,
  ]);
  const deleteProviderStatus = useMemo(
    () =>
      deleteProviderId
        ? (sortedApiKeyConnectedProviders.find(
            (provider) => provider.id === deleteProviderId,
          ) ?? null)
        : null,
    [deleteProviderId, sortedApiKeyConnectedProviders],
  );
  const openaiAndChatGptBothConfigured = Boolean(
    providerSetup?.openaiAndChatGptBothConfigured,
  );

  if (providerSetupPending) {
    return (
      <Section icon={KeyRound} title="Inference Providers">
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full max-w-2xl" />
          ))}
        </div>
      </Section>
    );
  }

  if (!providerSetup) {
    return (
      <Section icon={KeyRound} title="Inference Providers">
        <p className="text-sm text-destructive">
          Failed to load inference provider settings.
        </p>
      </Section>
    );
  }

  const hasConnectedApiKeys = sortedApiKeyConnectedProviders.length > 0;
  const hasConnectedProviders =
    hasConnectedApiKeys ||
    chatgptHasRecord ||
    githubCopilotHasRecord ||
    xaiHasRecord;
  const canAddProvider = sortedAddableProviders.length > 0;
  // Count key rows and subscription rows independently so dual-path xAI
  // (API key + SuperGrok) can delete the key while the subscription remains.
  const connectedProviderCount =
    sortedApiKeyConnectedProviders.length +
    (chatgptHasRecord ? 1 : 0) +
    (githubCopilotHasRecord ? 1 : 0) +
    (xaiHasRecord ? 1 : 0);

  return (
    <Section icon={KeyRound} title="Inference Providers">
      {!hasConnectedProviders && (
        <p className="text-sm text-muted-foreground">
          Connect a model provider to run tasks. Keys are encrypted in the
          database.
        </p>
      )}

      {openaiAndChatGptBothConfigured ? (
        <p className="text-sm text-muted-foreground">
          Both an OpenAI API key and a ChatGPT subscription are configured. The
          subscription is used at runtime when an <code>openai/</code> model is
          selected.
        </p>
      ) : null}

      {xaiHasRecord && xaiHasApiKey ? (
        <p className="text-sm text-muted-foreground">
          Both an xAI API key and a Grok subscription are configured. The
          subscription is preferred at runtime when an <code>xai/</code> model
          is selected.
        </p>
      ) : null}

      <ChatGptConnectDialog
        open={isChatGptDialogOpen}
        onOpenChange={setIsChatGptDialogOpen}
      />
      <GitHubCopilotConnectDialog
        open={isGitHubCopilotDialogOpen}
        onOpenChange={setIsGitHubCopilotDialogOpen}
      />
      <XaiConnectDialog
        open={isXaiDialogOpen}
        onOpenChange={setIsXaiDialogOpen}
      />
      {providerDialog ? (
        <ProviderCredentialsDialog
          open={true}
          mode={providerDialog.mode}
          providers={providerDialogProviders}
          isSaving={savingProviderId !== null}
          onSave={handleSave}
          onOpenChange={(open) => {
            if (!open) {
              setProviderDialog(null);
            }
          }}
          onConnectOAuth={(providerId) => {
            setProviderDialog(null);
            if (providerId === 'github-copilot') {
              setIsGitHubCopilotDialogOpen(true);
            } else if (providerId === XAI_SUBSCRIPTION_PROVIDER_ID) {
              setIsXaiDialogOpen(true);
            } else {
              setIsChatGptDialogOpen(true);
            }
          }}
        />
      ) : null}
      <DeleteProviderDialog
        provider={deleteProviderStatus}
        open={deleteProviderId !== null}
        isDeleting={deleteProvider.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteProviderId(null);
          }
        }}
        onConfirm={handleDeleteProvider}
      />

      <div className="divide-y divide-background">
        {hasConnectedProviders ? (
          <>
            {chatgptHasRecord ? (
              <ChatGptSubscriptionRow
                errored={chatgptErrored}
                accountEmail={chatgptStatus?.email}
                errorMessage={chatgptStatus?.error}
                usage={usageByProvider.get(CHATGPT_SUBSCRIPTION_PROVIDER_ID)}
                fastMode={chatgptStatus?.fastMode === true}
                onFastModeChange={handleChatGptFastModeChange}
                isUpdatingFastMode={updateChatGptFastMode.isPending}
                onReconnect={() => setIsChatGptDialogOpen(true)}
                onDisconnect={handleDisconnectChatGpt}
                isDisconnecting={disconnectChatGpt.isPending}
              />
            ) : null}
            {githubCopilotHasRecord ? (
              <GitHubCopilotSubscriptionRow
                errored={githubCopilotErrored}
                errorMessage={githubCopilotStatus?.error}
                usage={usageByProvider.get('github-copilot')}
                onReconnect={() => setIsGitHubCopilotDialogOpen(true)}
                onDisconnect={handleDisconnectGitHubCopilot}
                isDisconnecting={disconnectGitHubCopilot.isPending}
              />
            ) : null}
            {xaiHasRecord ? (
              <XaiSubscriptionRow
                errored={xaiErrored}
                accountEmail={xaiStatus?.email}
                errorMessage={xaiStatus?.error}
                usage={usageByProvider.get(XAI_SUBSCRIPTION_PROVIDER_ID)}
                onReconnect={() => setIsXaiDialogOpen(true)}
                onDisconnect={handleDisconnectXai}
                isDisconnecting={disconnectXai.isPending}
              />
            ) : null}
            {sortedApiKeyConnectedProviders.map((provider) => (
              <ConnectedProviderRow
                key={provider.id}
                provider={provider}
                usage={
                  isApiKeySubscriptionUsageProviderId(provider.id)
                    ? usageByProvider.get(provider.id)
                    : undefined
                }
                creditBalance={
                  provider.id === 'openrouter' ||
                  provider.id === ROOMOTE_INFERENCE_PROVIDER_ID
                    ? creditBalanceByProvider.get(provider.id)
                    : undefined
                }
                isSaving={savingProviderId === provider.id}
                canDelete={connectedProviderCount > 1}
                onEdit={() =>
                  setProviderDialog({ mode: 'edit', providerId: provider.id })
                }
                onDelete={() => setDeleteProviderId(provider.id)}
              />
            ))}
          </>
        ) : null}

        {canAddProvider ? (
          <div className="py-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setProviderDialog({ mode: 'add' })}
            >
              <Plus />
              Add provider
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

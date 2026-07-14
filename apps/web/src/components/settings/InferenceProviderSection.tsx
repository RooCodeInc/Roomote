'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  getModelProviderLabel,
} from '@roomote/types';
import type {
  SetupModelProviderId,
  SetupModelProviderStatus,
  SetupModelStatus,
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
  Trash2,
} from '@/components/system';
import { Section } from '@/components/settings/Section';
import { ChatGptConnectDialog } from '@/components/settings/ChatGptConnectDialog';

const MASKED_VALUE = '••••••••••••••••••••••••••••';
const PROVIDER_GRID_ROW_CLASS =
  'grid gap-2 md:grid-cols-[minmax(160px,220px)_minmax(0,1fr)] md:items-center';

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
  | { mode: 'add' }
  | { mode: 'edit'; providerId: SetupModelProviderId };

function getInitialAdditionalEnvValues(
  provider: SetupModelProviderStatus | null,
) {
  return provider?.additionalEnvValues ?? {};
}

function ConnectedProviderRow({
  provider,
  isSaving,
  canDelete,
  onEdit,
  onDelete,
}: {
  provider: SetupModelProviderStatus;
  isSaving: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hasRuntimeKey = provider.runtimeApiKeySatisfied;
  const isManagedProvider = provider.authKind === 'managed';
  const primaryCredentialLabel = provider.envVarLabel ?? 'API key';
  const runtimeKeyTooltip = isManagedProvider
    ? 'Inference is provided by Roomote Cloud and billed from workspace credits.'
    : provider.envVarName
      ? `Set by ${provider.envVarName}, not changeable in the UI.`
      : 'Set by an environment variable, not changeable in the UI.';
  const runtimeKeyLabel = isManagedProvider
    ? `${provider.label} inference is platform-managed`
    : provider.envVarName
      ? `${provider.label} API key is managed by ${provider.envVarName}`
      : `${provider.label} API key is managed by an environment variable`;
  const inputValue = isManagedProvider
    ? 'Included with Roomote Cloud credits'
    : MASKED_VALUE;

  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {provider.label}
        </span>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="w-full max-w-md">
          <Input
            className="min-w-0 w-full font-mono"
            value={inputValue}
            readOnly
            disabled
            aria-label={`${primaryCredentialLabel} for ${provider.label}`}
            data-1p-ignore
          />
        </div>

        {hasRuntimeKey || isManagedProvider ? (
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
  onConnectChatGpt,
}: {
  open: boolean;
  mode: 'add' | 'edit';
  providers: SetupModelProviderStatus[];
  isSaving: boolean;
  onSave: (
    providerId: SetupModelProviderId,
    apiKey: string,
    additionalEnvValues?: Record<string, string>,
  ) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onConnectChatGpt: () => void;
}) {
  const [selectedProviderId, setSelectedProviderId] =
    useState<SetupModelProviderId | null>(providers[0]?.id ?? null);
  const [apiKey, setApiKey] = useState('');
  const [providerSelectOpen, setProviderSelectOpen] = useState(false);
  const [additionalEnvValues, setAdditionalEnvValues] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!open) {
      return;
    }

    const provider = providers[0] ?? null;
    setSelectedProviderId(provider?.id ?? null);
    setApiKey('');
    setAdditionalEnvValues(getInitialAdditionalEnvValues(provider));
  }, [open, providers]);

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

  const handleSaveClick = async () => {
    if (!selectedProvider) {
      return;
    }

    try {
      await onSave(
        selectedProvider.id,
        apiKey.trim(),
        additionalEnvFields.length > 0 ? additionalEnvValues : undefined,
      );
      setApiKey('');
      setAdditionalEnvValues({});
    } catch {
      // The mutation surfaces failures via toast; keep the typed key so the
      // user can retry without re-entering it.
    }
  };

  const isChatGptProvider =
    selectedProvider?.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID;
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
                    setApiKey('');
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

              {isChatGptProvider ? (
                <div className={PROVIDER_GRID_ROW_CLASS}>
                  <span className="text-sm font-medium">Account</span>
                  <p className="min-w-0 text-sm text-muted-foreground">
                    Connect a ChatGPT Plus or Pro account to run tasks on your
                    subscription.
                  </p>
                </div>
              ) : (
                <>
                  <div className={PROVIDER_GRID_ROW_CLASS}>
                    <span className="text-sm font-medium">
                      {primaryCredentialLabel}
                    </span>
                    <div className="space-y-1.5">
                      <Input
                        secret
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
                      <Input
                        secret={field.secret}
                        className={field.secret ? 'font-mono' : undefined}
                        value={additionalEnvValues[field.envVarName] ?? ''}
                        onChange={(event) =>
                          setAdditionalEnvValues((values) => ({
                            ...values,
                            [field.envVarName]: event.target.value,
                          }))
                        }
                        placeholder={field.placeholder}
                        disabled={isSaving}
                        aria-label={`${field.label} for ${selectedProvider.label}`}
                        data-1p-ignore
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
          {isChatGptProvider ? (
            <Button size="sm" onClick={onConnectChatGpt} disabled={isSaving}>
              Connect ChatGPT
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void handleSaveClick()}
              disabled={
                isSaving ||
                !selectedProvider ||
                hasMissingPrimaryCredential ||
                hasMissingRequiredFields
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
  onReconnect,
  onDisconnect,
  isDisconnecting,
}: {
  errored: boolean;
  accountEmail?: string;
  errorMessage?: string;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  isDisconnecting: boolean;
}) {
  return (
    <div className={`${PROVIDER_GRID_ROW_CLASS} py-3 first:pt-0 last:pb-0`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          ChatGPT (subscription)
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        {errored ? (
          <p className="min-w-0 flex-1 truncate text-sm text-destructive">
            {errorMessage ?? 'ChatGPT subscription needs to be reconnected.'}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {accountEmail
              ? `Connected as ${accountEmail}`
              : 'Connected to a ChatGPT account.'}
          </p>
        )}

        {errored ? (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onReconnect}
          >
            Reconnect
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => void onDisconnect()}
          disabled={isDisconnecting}
        >
          {isDisconnecting ? <Spinner /> : 'Disconnect'}
        </Button>
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

  const chatgptStatusQuery = useQuery(
    trpc.chatgptSubscription.status.queryOptions(),
  );
  const chatgptStatus = chatgptStatusQuery.data ?? null;

  const saveProvider = useMutation(
    trpc.taskModels.saveProvider.mutationOptions({
      onSuccess: async (result, variables) => {
        const providerLabel = getModelProviderLabel(variables.provider);
        const addedModelCount = result.addedRecommendedModelCount;

        toast.success(
          addedModelCount > 0
            ? `Saved the ${providerLabel} API key and added ${addedModelCount} recommended ${addedModelCount === 1 ? 'model' : 'models'}.`
            : `Saved the ${providerLabel} API key.`,
        );
        setProviderDialog(null);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.taskModels.providerSetup.queryKey(),
          }),
          ...(addedModelCount > 0
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

        if (addedModelCount > 0) {
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
        await queryClient.invalidateQueries({
          queryKey: trpc.taskModels.providerSetup.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.chatgptSubscription.status.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
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
  ) => {
    setSavingProviderId(providerId);
    await saveProvider.mutateAsync({
      provider: providerId,
      ...(apiKey && { apiKey }),
      ...(additionalEnvValues && { additionalEnvValues }),
    });
  };

  const handleDisconnectChatGpt = async () => {
    await disconnectChatGpt.mutateAsync();
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

  // The ChatGPT provider is OAuth-backed: it renders as a connected row with
  // Disconnect/Reconnect when a subscription record exists, and otherwise
  // joins the add-provider dropdown with a Connect button instead of an API
  // key field. Exclude it from the API-key connected rows either way.
  const apiKeyConnectedProviders = connectedProviders.filter(
    (provider) => provider.id !== CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  );
  const addableProviders = availableProviders.filter((provider) =>
    provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID
      ? !chatgptHasRecord
      : provider.authKind === 'api-key',
  );
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
      return sortedAddableProviders;
    }

    const editProvider = sortedApiKeyConnectedProviders.find(
      (provider) => provider.id === providerDialog.providerId,
    );

    return editProvider ? [editProvider] : [];
  }, [providerDialog, sortedAddableProviders, sortedApiKeyConnectedProviders]);
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
  const hasConnectedProviders = hasConnectedApiKeys || chatgptHasRecord;
  const canAddProvider = sortedAddableProviders.length > 0;
  const connectedProviderCount =
    sortedApiKeyConnectedProviders.length + (chatgptHasRecord ? 1 : 0);

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

      <ChatGptConnectDialog
        open={isChatGptDialogOpen}
        onOpenChange={setIsChatGptDialogOpen}
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
          onConnectChatGpt={() => {
            setProviderDialog(null);
            setIsChatGptDialogOpen(true);
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
                onReconnect={() => setIsChatGptDialogOpen(true)}
                onDisconnect={handleDisconnectChatGpt}
                isDisconnecting={disconnectChatGpt.isPending}
              />
            ) : null}
            {sortedApiKeyConnectedProviders.map((provider) => (
              <ConnectedProviderRow
                key={provider.id}
                provider={provider}
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

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SetupAuthProviderStatus } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  useConnectSlack,
  useDisconnectSlack,
  useSlackInstallation,
} from '@/hooks/slack';
import { useTeamsIntegrationStatus } from '@/hooks/teams';
import { SETTINGS_PATHS } from '@/lib/settings';
import {
  getSetupEffectiveFieldValue,
  getSetupSubmitValues,
  getSetupVisibleFields,
  ProviderSetupExperience,
} from '@/app/(onboarding)/setup/ProviderSetupExperience';

type CommsProviderId = SetupAuthProviderStatus['id'] | 'telegram';
type TelegramWebhookStatus = {
  status: 'connected' | 'mismatch' | 'stale_updates' | 'unregistered' | 'error';
  registeredUrl: string | null;
  expectedUrl: string;
  lastErrorMessage: string | null;
  pendingUpdateCount?: number;
  lastErrorAtMs?: number | null;
};
type TelegramCommsProviderStatus = Omit<SetupAuthProviderStatus, 'id'> & {
  id: CommsProviderId;
  telegramWebhook?: TelegramWebhookStatus | null;
  telegramBotUsername?: string | null;
};

const TELEGRAM_WEBHOOK_STATUS_COPY: Record<
  TelegramWebhookStatus['status'],
  { label: string; tone: 'ok' | 'warn' }
> = {
  connected: { label: 'Webhook connected', tone: 'ok' },
  mismatch: {
    label:
      'Webhook points at a different URL — save again to re-register it for this deployment',
    tone: 'warn',
  },
  stale_updates: {
    label:
      'Webhook is registered without button support — save again to refresh it',
    tone: 'warn',
  },
  unregistered: {
    label:
      'Webhook not registered yet — it is registered automatically when you save',
    tone: 'warn',
  },
  error: {
    label: 'Could not check the Telegram webhook status',
    tone: 'warn',
  },
};

import {
  ArrowLeft,
  BrandIcon,
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Info,
  Plug,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
  Trash2,
  TriangleAlert,
} from '@/components/system';
import { Section } from './Section';
import { TelegramLinkAccountStep } from './TelegramLinkAccountStep';

const MICROSOFT_APP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getProviderIconId(providerId: CommsProviderId): string {
  return providerId === 'microsoft' ? 'teams' : providerId;
}

type SlackChannelOption = {
  id: string;
  name: string;
  label: string;
  isPrivate?: boolean;
  isMember?: boolean | null;
};

const ROUTER_DEBUG_CHANNEL_NONE_VALUE = '__none__';

function getChannelLabel(
  channelId: string | null | undefined,
  channels: SlackChannelOption[],
) {
  if (!channelId) {
    return null;
  }

  return (
    channels.find((channel) => channel.id === channelId)?.label ?? channelId
  );
}

function buildRouterDebugChannelOptions({
  channels,
  selectedChannelId,
  envFallbackChannelId,
}: {
  channels: SlackChannelOption[];
  selectedChannelId: string | null;
  envFallbackChannelId: string | null;
}) {
  const options = [...channels];
  const optionIds = new Set(options.map((channel) => channel.id));

  for (const channelId of [selectedChannelId, envFallbackChannelId]) {
    if (channelId && !optionIds.has(channelId)) {
      options.push({
        id: channelId,
        name: channelId,
        label: channelId,
        isMember: null,
      });
      optionIds.add(channelId);
    }
  }

  return options;
}

function SlackWorkspaceAuthButton({ configured }: { configured: boolean }) {
  const slackInstallation = useSlackInstallation();
  const connectSlack = useConnectSlack(SETTINGS_PATHS.comms);
  const disconnectSlack = useDisconnectSlack();

  const isInstalled = Boolean(slackInstallation.data);
  const isPending =
    slackInstallation.isPending ||
    connectSlack.isPending ||
    disconnectSlack.isPending;

  const handleClick = () => {
    if (isInstalled) {
      disconnectSlack.mutate(undefined, {
        onSuccess: () => {
          connectSlack.mutate(undefined, {
            onSuccess: (url) => {
              window.location.href = url;
            },
            onError: () =>
              toast.error(
                'Slack workspace removed, but re-auth could not start. Click Auth to retry.',
              ),
          });
        },
        onError: () =>
          toast.error('Failed to replace Slack workspace connection.'),
      });
      return;
    }

    connectSlack.mutate(undefined, {
      onSuccess: (url) => {
        window.location.href = url;
      },
      onError: () =>
        toast.error('Failed to start Slack workspace authorization.'),
    });
  };

  if (!configured) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      aria-label={
        isInstalled ? 'Re-auth Slack workspace' : 'Auth Slack workspace'
      }
      onClick={handleClick}
      disabled={isPending}
    >
      {isPending ? <Spinner size="sm" /> : <Plug className="size-4" />}
      {isInstalled ? 'Re-auth' : 'Auth'}
    </Button>
  );
}

function SlackDiagnosticsChannel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routerDebugSettingsQueryKey = trpc.routerDebug.getSettings.queryKey();
  const slackInstallation = useSlackInstallation();

  const slackConnected = Boolean(slackInstallation.data);

  const routerDebugSettings = useQuery(
    trpc.routerDebug.getSettings.queryOptions(),
  );
  const slackChannelsQuery = useQuery(
    trpc.automations.listSlackChannels.queryOptions(undefined, {
      enabled: Boolean(slackConnected),
    }),
  );
  const updateRouterDebugSettings = useMutation(
    trpc.routerDebug.updateSettings.mutationOptions({
      onSuccess: (settings) => {
        queryClient.setQueryData(routerDebugSettingsQueryKey, settings);
        setDraftChannelId(settings.routerDebugSlackChannelId);
        toast.success('Diagnostics channel updated.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to update diagnostics channel.');
      },
    }),
  );

  const [draftChannelId, setDraftChannelId] = useState<string | null>(
    routerDebugSettings.data?.routerDebugSlackChannelId ?? null,
  );

  useEffect(() => {
    if (routerDebugSettings.data === undefined) {
      return;
    }

    setDraftChannelId(routerDebugSettings.data.routerDebugSlackChannelId);
  }, [routerDebugSettings.data]);

  if (!slackConnected) {
    return null;
  }

  const settings = routerDebugSettings.data;
  const envFallbackChannelId = settings?.envFallbackSlackChannelId ?? null;
  const effectiveChannelId =
    settings?.effectiveRouterDebugSlackChannelId ?? null;
  const channels = (slackChannelsQuery.data?.channels ??
    []) as SlackChannelOption[];
  const channelOptions = buildRouterDebugChannelOptions({
    channels,
    selectedChannelId: draftChannelId,
    envFallbackChannelId,
  });
  const draftLabel = getChannelLabel(draftChannelId, channelOptions);
  const effectiveLabel = getChannelLabel(effectiveChannelId, channelOptions);
  const persistedChannelId = settings?.routerDebugSlackChannelId ?? null;
  const dirty = draftChannelId !== persistedChannelId;
  const selectDisabled =
    routerDebugSettings.isPending ||
    routerDebugSettings.isError ||
    !slackConnected ||
    updateRouterDebugSettings.isPending;
  const saveDisabled =
    !dirty ||
    selectDisabled ||
    slackChannelsQuery.isPending ||
    slackChannelsQuery.isError;

  return (
    <div className="space-y-3 max-w-xl">
      <div className="space-y-1">
        <p className="text-sm font-medium">Diagnostics channel</p>
        <p className="text-sm text-muted-foreground">
          Slack channel that receives routing diagnostics posts.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select
            value={draftChannelId ?? ROUTER_DEBUG_CHANNEL_NONE_VALUE}
            disabled={selectDisabled}
            onValueChange={(value) => {
              setDraftChannelId(
                value === ROUTER_DEBUG_CHANNEL_NONE_VALUE ? null : value,
              );
            }}
          >
            <SelectTrigger
              id="comms-slack-diagnostics-channel"
              className="w-full"
            >
              <span className="truncate text-left">
                {draftLabel ??
                  (envFallbackChannelId
                    ? `Use env fallback (${envFallbackChannelId})`
                    : 'No diagnostics channel')}
              </span>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ROUTER_DEBUG_CHANNEL_NONE_VALUE}>
                {envFallbackChannelId
                  ? 'Use env fallback'
                  : 'No diagnostics channel'}
              </SelectItem>
              {slackChannelsQuery.isPending ? (
                <SelectItem value="__loading__" disabled>
                  Loading channels...
                </SelectItem>
              ) : slackChannelsQuery.isError ? (
                <SelectItem value="__error__" disabled>
                  Could not load channels. Try refreshing.
                </SelectItem>
              ) : channelOptions.length > 0 ? (
                channelOptions.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {channel.label}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="__empty__" disabled>
                  No channels found.
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Refresh Slack channels"
          title="Refresh Slack channels"
          disabled={!slackConnected || slackChannelsQuery.isFetching}
          onClick={() => {
            void slackChannelsQuery.refetch();
          }}
        >
          {slackChannelsQuery.isFetching ? (
            <Spinner size="sm" />
          ) : (
            <RefreshCw />
          )}
        </Button>
      </div>
      {routerDebugSettings.isError ? (
        <p className="text-sm text-destructive">
          Failed to load diagnostics settings.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {settings?.source === 'deployment' && effectiveLabel
            ? `Diagnostics posts currently go to ${effectiveLabel}.`
            : settings?.source === 'env' && effectiveLabel
              ? `Diagnostics posts currently use the env fallback ${effectiveLabel}.`
              : 'Diagnostics posts are disabled until a channel is selected.'}
        </p>
      )}
      <div>
        <Button
          type="button"
          disabled={saveDisabled}
          onClick={() => {
            updateRouterDebugSettings.mutate({
              routerDebugSlackChannelId: draftChannelId,
            });
          }}
        >
          {updateRouterDebugSettings.isPending ? <Spinner size="sm" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

function TeamsBotStatus() {
  const teamsIntegrationStatus = useTeamsIntegrationStatus();

  if (teamsIntegrationStatus.isPending) {
    return (
      <p className="text-sm text-muted-foreground">
        Checking Microsoft Teams bot configuration.
      </p>
    );
  }

  if (teamsIntegrationStatus.isError) {
    return (
      <p className="text-sm text-destructive">
        Unable to read Microsoft Teams configuration.
      </p>
    );
  }

  const teamsStatus = teamsIntegrationStatus.data;
  const teamsBotConfigured = Boolean(teamsStatus?.botConfigured);
  const teamsOpenInTeamsUrl = teamsStatus?.openInTeamsUrl ?? null;
  const teamsPrimaryConversationReady = Boolean(
    teamsStatus?.primaryConversationReady,
  );

  const statusCopy = teamsBotConfigured ? (
    teamsStatus?.microsoftAuthConfigured ? (
      <>
        Bot configured. Team members can link Microsoft Teams accounts from{' '}
        <Link
          href={SETTINGS_PATHS.personal}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          Personal settings
        </Link>
        .
      </>
    ) : (
      'Bot configured for incoming Teams messages. Add R_MICROSOFT_* env vars to enable personal account linking.'
    )
  ) : (
    <>
      Add R_TEAMS_BOT_APP_ID and R_TEAMS_BOT_APP_PASSWORD, then set the Azure
      Bot messaging endpoint to{' '}
      <span className="break-all font-mono">
        {teamsStatus?.webhookUrl ?? '/api/webhooks/teams'}
      </span>
      .
    </>
  );

  return (
    <div className="space-y-2 mt-4">
      <div className="flex items-start gap-2">
        {!teamsBotConfigured ? (
          <TriangleAlert className="size-4 mt-0.5 shrink-0 text-amber-600" />
        ) : (
          <Info className="size-4 mt-0.5 shrink-0" />
        )}
        <p className="text-sm text-muted-foreground">{statusCopy}</p>
      </div>
      {teamsBotConfigured && !teamsPrimaryConversationReady ? (
        <div className="flex items-start gap-2">
          <TriangleAlert className="size-4 mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-muted-foreground">
            Roomote has not captured a Teams conversation yet, so setup and
            automation messages cannot reach Teams. Install or open the Roomote
            app in Teams and send the bot one message to finish connecting.
          </p>
        </div>
      ) : null}
      {teamsOpenInTeamsUrl ? (
        <div>
          <Button asChild variant="outline" size="sm">
            <a
              href={teamsOpenInTeamsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              Open in Teams
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type CommsProviderSectionProps = {
  provider: TelegramCommsProviderStatus;
  onSave: (provider: CommsProviderId, values: Record<string, string>) => void;
  onClear: (provider: CommsProviderId) => void;
  savePending: boolean;
  clearPending: boolean;
};

export function CommsProviderSection({
  provider,
  onSave,
  onClear,
  savePending,
  clearPending,
}: CommsProviderSectionProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const repairTelegram = useMutation(
    trpc.comms.repairTelegram.mutationOptions({
      onSuccess: async () => {
        toast.success('Telegram connection repaired');
        await queryClient.invalidateQueries({
          queryKey: trpc.comms.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const isMicrosoftProvider = provider.id === 'microsoft';
  const teamsIntegrationStatus = useTeamsIntegrationStatus({
    enabled: isMicrosoftProvider,
  });
  const teamsBotConfigured = Boolean(
    teamsIntegrationStatus.data?.botConfigured,
  );

  const [expanded, setExpanded] = useState(
    () =>
      provider.runtimeSatisfied ||
      provider.savedSatisfied ||
      (isMicrosoftProvider && teamsBotConfigured),
  );
  const nonSecretValuesKey = provider.fields
    .filter((field) => field.secret !== true)
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = Object.fromEntries(
    provider.fields
      .filter((field) => field.secret !== true && field.savedValue?.trim())
      .map((field) => [field.envVarName, field.savedValue!.trim()]),
  );
  const [values, setValues] = useState<Record<string, string>>(
    nonSecretInitialValues,
  );
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [clearedSavedValues, setClearedSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [showManualSlackValues, setShowManualSlackValues] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setClearedSavedValues({});
    setShowManualSlackValues(false);
    setRemoveDialogOpen(false);
    // nonSecretInitialValues is content-keyed to avoid identity-only resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
  }, [
    provider.id,
    provider.runtimeSatisfied,
    provider.savedSatisfied,
    nonSecretValuesKey,
  ]);

  useEffect(() => {
    setExpanded(
      provider.runtimeSatisfied ||
        provider.savedSatisfied ||
        (isMicrosoftProvider && teamsBotConfigured),
    );
  }, [
    provider.runtimeSatisfied,
    provider.savedSatisfied,
    isMicrosoftProvider,
    teamsBotConfigured,
  ]);

  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const visibleFields = getSetupVisibleFields(provider);

  const hasPendingValueChanges = visibleFields.some((field) => {
    if (field.runtimeSatisfied) {
      return false;
    }

    const nextValue = values[field.envVarName]?.trim() ?? '';
    if (field.secret !== true) {
      const savedValue = field.savedValue?.trim() ?? '';
      return (
        nextValue !== savedValue ||
        Boolean(clearedSavedValues[field.envVarName])
      );
    }

    return (
      nextValue.length > 0 || Boolean(clearedSavedValues[field.envVarName])
    );
  });

  const hasMissingRequiredValue = visibleFields.some((field) => {
    const nextValue = getSetupEffectiveFieldValue({
      provider,
      field,
      values,
    }).trim();
    return (
      field.required !== false &&
      !field.runtimeSatisfied &&
      (!field.savedSatisfied || clearedSavedValues[field.envVarName]) &&
      nextValue.length === 0
    );
  });

  const isActionDisabled = !hasPendingValueChanges || hasMissingRequiredValue;

  const hasConfiguredValues =
    provider.runtimeSatisfied || provider.savedSatisfied;
  const hasEditableFields = visibleFields.some(
    (field) => !field.runtimeSatisfied,
  );
  const providerOwnsActions =
    provider.id === 'slack' && !showManualSlackValues && !hasConfiguredValues;

  const teamsBotAppIdField = provider.fields.find(
    (field) => field.envVarName === 'R_TEAMS_BOT_APP_ID',
  );
  const teamsBotNameField = provider.fields.find(
    (field) => field.envVarName === 'R_TEAMS_BOT_NAME',
  );
  const enteredTeamsBotAppId =
    isMicrosoftProvider && teamsBotAppIdField
      ? getSetupEffectiveFieldValue({
          provider,
          field: teamsBotAppIdField,
          values,
        }).trim()
      : '';
  const typedTeamsBotAppId = MICROSOFT_APP_ID_PATTERN.test(enteredTeamsBotAppId)
    ? enteredTeamsBotAppId
    : '';
  const typedTeamsBotName =
    isMicrosoftProvider && teamsBotNameField
      ? getSetupEffectiveFieldValue({
          provider,
          field: teamsBotNameField,
          values,
        }).trim()
      : '';
  const teamsBotAppIdStored = isMicrosoftProvider
    ? provider.fields.some(
        (field) =>
          (field.envVarName === 'R_TEAMS_BOT_APP_ID' ||
            field.envVarName === 'R_MICROSOFT_CLIENT_ID') &&
          (field.runtimeSatisfied || field.savedSatisfied),
      )
    : false;
  const teamsSetupPackageParams = new URLSearchParams();
  if (typedTeamsBotAppId) {
    teamsSetupPackageParams.set('botAppId', typedTeamsBotAppId);
  }
  if (typedTeamsBotName) {
    teamsSetupPackageParams.set('botName', typedTeamsBotName);
  }
  const teamsAppPackageHref = typedTeamsBotAppId
    ? `/api/setup/teams-app-package?${teamsSetupPackageParams.toString()}`
    : teamsBotAppIdStored || teamsBotConfigured
      ? '/api/teams/app-package'
      : null;

  const handleSave = () => {
    onSave(provider.id, getSetupSubmitValues({ provider, values }));
  };

  const handleRemove = () => {
    onClear(provider.id);
  };

  return (
    <>
      <Section
        icon={
          <BrandIcon
            icon={getProviderIconId(provider.id)}
            name=""
            className="size-4 shrink-0"
          />
        }
        title={provider.label}
        action={
          provider.id === 'slack' ? (
            <SlackWorkspaceAuthButton configured={hasConfiguredValues} />
          ) : null
        }
      >
        {!expanded && !provider.runtimeSatisfied && !provider.savedSatisfied ? (
          <p className="text-sm text-muted-foreground">
            Not configured.{' '}
            <button
              type="button"
              className="underline underline-offset-4 hover:text-accent-foreground cursor-pointer"
              onClick={() => setExpanded(true)}
            >
              Set it up
            </button>
          </p>
        ) : (
          <div className="space-y-8">
            <ProviderSetupExperience
              provider={provider}
              values={values}
              publicOrigin={publicOrigin}
              disabled={savePending}
              editingSavedValues={editingSavedValues}
              clearedSavedValues={clearedSavedValues}
              teamsAppPackageHref={teamsAppPackageHref}
              showManualSlackValues={showManualSlackValues}
              surface="settings"
              envVarsInfoNote={
                !provider.runtimeSatisfied && provider.id === 'telegram'
                  ? 'Roomote generates a webhook secret automatically, registers the webhook when you save, and defaults Telegram task launches to the admin who saves this configuration.'
                  : undefined
              }
              onShowManualSlackValues={() => setShowManualSlackValues(true)}
              onValueChange={(envVarName, value) =>
                setValues((current) => ({ ...current, [envVarName]: value }))
              }
              onEditingSavedValueChange={(envVarName, editing) =>
                setEditingSavedValues((current) => ({
                  ...current,
                  [envVarName]: editing,
                }))
              }
              onClearedSavedValueChange={(envVarName, cleared) =>
                setClearedSavedValues((current) => ({
                  ...current,
                  [envVarName]: cleared,
                }))
              }
            />

            <div className="space-y-2 text-sm text-muted-foreground">
              {provider.id === 'telegram' && provider.telegramWebhook && (
                <div className="flex items-start gap-2 mt-4">
                  {TELEGRAM_WEBHOOK_STATUS_COPY[provider.telegramWebhook.status]
                    .tone === 'ok' ? (
                    <Check className="inline size-4 mt-0.5 shrink-0 text-green-600" />
                  ) : (
                    <Info className="inline size-4 mt-0.5 shrink-0 text-amber-600" />
                  )}
                  <p className="text-sm">
                    {provider.telegramWebhook.status === 'connected' &&
                    provider.telegramBotUsername
                      ? `Connected to @${provider.telegramBotUsername}`
                      : provider.telegramWebhook.status === 'error'
                        ? (provider.telegramWebhook.lastErrorMessage ??
                          TELEGRAM_WEBHOOK_STATUS_COPY.error.label)
                        : TELEGRAM_WEBHOOK_STATUS_COPY[
                            provider.telegramWebhook.status
                          ].label}
                    {provider.telegramWebhook.status !== 'error' &&
                    provider.telegramWebhook.lastErrorMessage
                      ? ` Last delivery error: ${provider.telegramWebhook.lastErrorMessage}`
                      : ''}
                    {(provider.telegramWebhook.pendingUpdateCount ?? 0) > 0
                      ? ` ${provider.telegramWebhook.pendingUpdateCount} update${provider.telegramWebhook.pendingUpdateCount === 1 ? '' : 's'} waiting for delivery.`
                      : ''}
                  </p>
                  {provider.telegramWebhook.status !== 'connected' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={repairTelegram.isPending}
                      onClick={() => repairTelegram.mutate()}
                    >
                      <RefreshCw />
                      {repairTelegram.isPending ? 'Repairing...' : 'Repair'}
                    </Button>
                  ) : null}
                </div>
              )}
              {provider.id === 'telegram' && hasConfiguredValues && (
                <TelegramLinkAccountStep />
              )}
              {provider.id === 'microsoft' &&
                (hasConfiguredValues || teamsBotConfigured) && (
                  <TeamsBotStatus />
                )}
              {provider.id === 'slack' && hasConfiguredValues && (
                <SlackDiagnosticsChannel />
              )}
            </div>

            {providerOwnsActions ? null : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {provider.id === 'slack' && !hasConfiguredValues && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowManualSlackValues(false)}
                  >
                    <ArrowLeft />
                    Back
                  </Button>
                )}
                {provider.savedSatisfied && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRemoveDialogOpen(true)}
                    disabled={clearPending}
                  >
                    <Trash2 />
                    {clearPending ? 'Removing...' : 'Remove'}
                    {clearPending ? <Spinner /> : null}
                  </Button>
                )}
                {hasEditableFields && (
                  <Button
                    type="button"
                    onClick={handleSave}
                    disabled={isActionDisabled || savePending}
                  >
                    <Check />
                    {savePending ? 'Saving...' : 'Save'}
                    {savePending ? <Spinner /> : null}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Section>
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove {provider.label} credentials?</DialogTitle>
            <DialogDescription>
              Saved {provider.label} credentials will be removed from the
              database. Configured environment variables are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveDialogOpen(false)}
              disabled={clearPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemove}
              disabled={clearPending}
            >
              <Trash2 />
              {clearPending ? 'Removing...' : 'Remove'}
              {clearPending ? <Spinner /> : null}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

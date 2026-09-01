'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SetupAuthProviderStatus } from '@roomote/types';
import type { AgentMailCommsStatus } from '@/trpc/commands/comms';

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
  getTeamsAppPackageUnavailableReason,
  MICROSOFT_APP_ID_PATTERN,
  ProviderSetupExperience,
} from '@/app/(onboarding)/setup/ProviderSetupExperience';

type CommsProviderId =
  | SetupAuthProviderStatus['id']
  | 'telegram'
  | 'discord'
  | 'agentmail';
type TelegramWebhookStatus = {
  status: 'connected' | 'mismatch' | 'stale_updates' | 'unregistered' | 'error';
  registeredUrl: string | null;
  expectedUrl: string;
  lastErrorMessage: string | null;
  pendingUpdateCount?: number;
  lastErrorAtMs?: number | null;
};
type CommsProviderStatus = Omit<SetupAuthProviderStatus, 'id'> & {
  id: CommsProviderId;
  telegramWebhook?: TelegramWebhookStatus | null;
  telegramBotUsername?: string | null;
  discord?: import('@/trpc/commands/comms').DiscordCommsStatus | null;
  agentmail?: AgentMailCommsStatus | null;
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
  Input,
  Mail,
  Plug,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Trash2,
  TriangleAlert,
} from '@/components/system';
import { Section } from './Section';
import { TelegramLinkAccountStep } from './TelegramLinkAccountStep';
import { DiscordSetupStatus } from './DiscordSetupStatus';
import { SlackManifestUpdateDialog } from './SlackManifestUpdateDialog';

function getProviderIconId(providerId: CommsProviderId): string {
  return providerId === 'microsoft' ? 'teams' : providerId;
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
  const teamsCredentialCheck = teamsStatus?.botCredentialCheck ?? null;
  const teamsCredentialsRejected = teamsCredentialCheck?.status === 'failed';

  const statusCopy = teamsCredentialsRejected ? (
    (teamsCredentialCheck?.message ??
    'Microsoft rejected the saved Teams bot credentials.')
  ) : teamsBotConfigured ? (
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
        {!teamsBotConfigured || teamsCredentialsRejected ? (
          <TriangleAlert className="size-4 mt-0.5 shrink-0 text-amber-600" />
        ) : (
          <Info className="size-4 mt-0.5 shrink-0" />
        )}
        <p className="text-sm text-muted-foreground">{statusCopy}</p>
      </div>
      {teamsCredentialCheck?.status === 'unchecked' &&
      teamsCredentialCheck.message ? (
        <div className="flex items-start gap-2">
          <Info className="size-4 mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground">
            {teamsCredentialCheck.message}
          </p>
        </div>
      ) : null}
      {teamsBotConfigured &&
      !teamsCredentialsRejected &&
      !teamsPrimaryConversationReady ? (
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

const AGENTMAIL_WEBHOOK_STATUS_COPY: Record<
  'connected' | 'mismatch' | 'unregistered' | 'error',
  { label: string; tone: 'ok' | 'warn' }
> = {
  connected: { label: 'Webhook connected', tone: 'ok' },
  mismatch: {
    label:
      'Webhook points at a different URL — save again to re-register it for this deployment',
    tone: 'warn',
  },
  unregistered: {
    label:
      'Webhook not registered yet — it is registered automatically when you save',
    tone: 'warn',
  },
  error: {
    label: 'Could not check the AgentMail webhook status',
    tone: 'warn',
  },
};

function AgentMailSetupStatus({
  status,
}: {
  status: NonNullable<CommsProviderStatus['agentmail']>;
}) {
  const webhookCopy = AGENTMAIL_WEBHOOK_STATUS_COPY[status.webhook.status];

  return (
    <div className="space-y-2 mt-4">
      {status.inboxAddress ? (
        <div className="flex items-start gap-2">
          <Mail className="size-4 mt-0.5 shrink-0" />
          <p className="text-sm">
            Inbox:{' '}
            <span className="break-all font-mono">
              {status.inboxEmail ?? status.inboxAddress}
            </span>
            {status.inboxEmail && status.inboxEmail !== status.inboxAddress ? (
              <span className="text-muted-foreground">
                {' '}
                (id: {status.inboxAddress})
              </span>
            ) : null}
          </p>
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        {webhookCopy.tone === 'ok' ? (
          <Check className="inline size-4 mt-0.5 shrink-0 text-green-600" />
        ) : (
          <Info className="inline size-4 mt-0.5 shrink-0 text-amber-600" />
        )}
        <p className="text-sm">
          {status.webhook.status === 'error'
            ? (status.webhook.errorMessage ??
              AGENTMAIL_WEBHOOK_STATUS_COPY.error.label)
            : webhookCopy.label}
          {status.webhook.registeredUrl ? (
            <>
              {' '}
              <span className="break-all font-mono">
                {status.webhook.registeredUrl}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

const AGENTMAIL_CREATE_NEW_INBOX_OPTION = '__agentmail_create_new__';
const AGENTMAIL_MANUAL_INBOX_OPTION = '__agentmail_manual__';

/**
 * Chooser for the AgentMail inbox: lists the inboxes the API key can see plus
 * a "create new" option for this deployment's proposed address, instead of a
 * free-text field. Manual entry stays available for inboxes the key cannot
 * list yet (e.g. custom domains). Writes the chosen address into the
 * R_AGENTMAIL_INBOX_ID form value; the save reconcile does the rest.
 */
function AgentMailInboxChooser({
  enteredApiKey,
  keyConfigured,
  value,
  savedSatisfied,
  disabled,
  onChange,
}: {
  /** API key currently typed into the form (already trimmed). */
  enteredApiKey: string;
  /** The API key field is satisfied by a saved or runtime value. */
  keyConfigured: boolean;
  value: string;
  savedSatisfied: boolean;
  disabled: boolean;
  onChange: (address: string) => void;
}) {
  // A key typed into the form only loads on request, so AgentMail is not
  // called on every keystroke. A saved-and-connected config never loads
  // automatically either — the status block already names the inbox, so
  // AgentMail is only called when the operator actually opens the chooser.
  const [loadedEnteredKey, setLoadedEnteredKey] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [chooserRequested, setChooserRequested] = useState(false);

  const hasEnteredKey = enteredApiKey.length > 0;
  const keyAvailable = hasEnteredKey || keyConfigured;
  const loadWanted = chooserRequested || (keyAvailable && !savedSatisfied);
  const loadEnabled =
    loadWanted &&
    keyAvailable &&
    (!hasEnteredKey || loadedEnteredKey === enteredApiKey);

  // A mutation rather than a query: the typed API key travels in the POST
  // body instead of being serialized into a GET URL (browser history, proxy
  // logs, tracing). The mutationFn calls the tRPC HTTP endpoint directly
  // instead of going through the tRPC client: mutation promises from the
  // client's link stack have been observed to never settle in the browser
  // (the request completes server-side; the hang is client-internal), and
  // this endpoint's shape is simple enough that a direct call is the
  // sturdier choice until that is root-caused.
  const loadInboxes = useMutation({
    mutationFn: async (input: { apiKey?: string }) => {
      const response = await fetch(
        '/api/trpc/comms.listAgentMailInboxes?batch=1',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ 0: { json: input } }),
        },
      );
      const batch = (await response.json()) as Array<{
        result?: {
          data: {
            json: {
              inboxes: Array<{ inboxId: string; email: string }>;
              proposedNewAddress: string;
            };
          };
        };
        error?: { json: { message: string } };
      }>;
      const item = batch[0];
      if (!item || item.error || !item.result) {
        throw new Error(
          item?.error?.json.message ?? 'Failed to load AgentMail inboxes.',
        );
      }
      return item.result.data.json;
    },
  });
  const requestedKeyRef = useRef<string | null>(null);
  const requestKey = hasEnteredKey ? enteredApiKey : '';
  // savedSatisfied joins the signature so a save that just created the
  // inbox refreshes the list (mutations have no query cache to invalidate).
  const requestSignature = `${savedSatisfied ? 'saved' : 'unsaved'}:${requestKey}`;
  const { mutate: loadInboxesMutate } = loadInboxes;

  useEffect(() => {
    if (!loadEnabled || requestedKeyRef.current === requestSignature) {
      return;
    }
    requestedKeyRef.current = requestSignature;
    loadInboxesMutate(requestKey ? { apiKey: requestKey } : {});
  }, [loadEnabled, requestKey, requestSignature, loadInboxesMutate]);

  const inboxesLoading =
    loadInboxes.isPending ||
    (loadEnabled && !loadInboxes.isSuccess && !loadInboxes.isError);

  // Entries pair the routed inbox_id (the submitted value) with the
  // deliverable email (the label); they are equal today but may diverge.
  const inboxes = loadInboxes.data?.inboxes ?? [];
  const inboxIds = inboxes.map((inbox) => inbox.inboxId);
  const proposedNewAddress = loadInboxes.data?.proposedNewAddress ?? null;
  const proposalAlreadyExists = Boolean(
    proposedNewAddress && inboxIds.includes(proposedNewAddress),
  );
  const normalizedValue = value.trim().toLowerCase();
  const selectValue = !normalizedValue
    ? undefined
    : inboxIds.includes(normalizedValue)
      ? normalizedValue
      : normalizedValue === proposedNewAddress && !proposalAlreadyExists
        ? AGENTMAIL_CREATE_NEW_INBOX_OPTION
        : undefined;
  // A value the account listing does not contain (custom domain, older
  // config) keeps the manual input visible so it is never silently hidden.
  // A saved config also rests on the input until the chooser is opened.
  const showManualInput =
    manualEntry ||
    !keyAvailable ||
    (savedSatisfied && !chooserRequested) ||
    (loadInboxes.isSuccess &&
      normalizedValue.length > 0 &&
      selectValue === undefined);

  const manualEntryLink = (
    <button
      type="button"
      className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
      onClick={() => setManualEntry(true)}
      disabled={disabled}
    >
      Enter address manually
    </button>
  );

  return (
    <div className="max-w-xl space-y-2">
      <div className="text-sm font-medium">Inbox Email Address (optional)</div>
      <p className="text-sm text-muted-foreground">
        The inbox Roomote receives mail at. Leave it unset to let Roomote adopt
        the account&apos;s only inbox or create one when you save.
      </p>
      {showManualInput ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              className="font-mono"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Inbox Email Address"
              disabled={disabled}
              data-1p-ignore
            />
            {savedSatisfied && <Check />}
          </div>
          {keyAvailable ? (
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
              onClick={() => {
                setManualEntry(false);
                setChooserRequested(true);
              }}
              disabled={disabled}
            >
              Choose from account inboxes
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Enter the AgentMail API key above to choose from the
              account&apos;s inboxes.
            </p>
          )}
        </div>
      ) : !loadEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLoadedEnteredKey(enteredApiKey)}
            disabled={disabled}
          >
            <RefreshCw />
            Load inboxes
          </Button>
          {manualEntryLink}
        </div>
      ) : inboxesLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          Loading inboxes…
        </div>
      ) : loadInboxes.isError ? (
        <div className="space-y-1">
          <p className="text-sm text-destructive">
            {loadInboxes.error.message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                loadInboxes.mutate(requestKey ? { apiKey: requestKey } : {})
              }
              disabled={disabled}
            >
              <RefreshCw />
              Retry
            </Button>
            {manualEntryLink}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            value={selectValue}
            onValueChange={(option) => {
              if (option === AGENTMAIL_MANUAL_INBOX_OPTION) {
                setManualEntry(true);
                return;
              }
              setManualEntry(false);
              onChange(
                option === AGENTMAIL_CREATE_NEW_INBOX_OPTION
                  ? (proposedNewAddress ?? '')
                  : option,
              );
            }}
            disabled={disabled}
          >
            <SelectTrigger className="w-full font-mono">
              <SelectValue placeholder="Choose an inbox" />
            </SelectTrigger>
            <SelectContent>
              {inboxes.map((inbox) => (
                <SelectItem key={inbox.inboxId} value={inbox.inboxId}>
                  {inbox.email !== inbox.inboxId
                    ? `${inbox.email} (${inbox.inboxId})`
                    : inbox.inboxId}
                </SelectItem>
              ))}
              {proposedNewAddress && !proposalAlreadyExists ? (
                <SelectItem value={AGENTMAIL_CREATE_NEW_INBOX_OPTION}>
                  Create new: {proposedNewAddress}
                </SelectItem>
              ) : null}
              <SelectItem value={AGENTMAIL_MANUAL_INBOX_OPTION}>
                Enter address manually
              </SelectItem>
            </SelectContent>
          </Select>
          {savedSatisfied && <Check />}
        </div>
      )}
    </div>
  );
}

type CommsProviderSectionProps = {
  provider: CommsProviderStatus;
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
  const createSlackApp = useMutation(
    trpc.slack.createAppFromManifest.mutationOptions({
      onSuccess: async (result) => {
        if (!result.success) {
          toast.error(result.error);
          return;
        }

        setCreatedSlackAppSettingsUrl(result.appSettingsUrl);
        setCreatedSlackAppIconSet(result.iconSet);
        setSlackCreateWithConfigToken(false);
        toast.success(
          result.iconSet
            ? 'Slack app created and credentials saved. Connect it to your workspace next.'
            : 'Slack app created and credentials saved. Add the Roomote icon, then connect it to your workspace.',
        );
        await queryClient.invalidateQueries({
          queryKey: trpc.comms.status.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.environmentVariables.list.queryKey(),
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
  const [createdSlackAppSettingsUrl, setCreatedSlackAppSettingsUrl] = useState<
    string | null
  >(null);
  const [createdSlackAppIconSet, setCreatedSlackAppIconSet] = useState<
    boolean | null
  >(null);
  const [slackCreateWithConfigToken, setSlackCreateWithConfigToken] =
    useState(false);
  const previousConfiguredValues = useRef<{
    providerId: CommsProviderId;
    hasConfiguredValues: boolean;
  } | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setClearedSavedValues({});
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

  useEffect(() => {
    const previous = previousConfiguredValues.current;

    if (
      previous?.providerId !== provider.id ||
      (provider.id === 'slack' &&
        previous.hasConfiguredValues &&
        !hasConfiguredValues)
    ) {
      setCreatedSlackAppSettingsUrl(null);
      setCreatedSlackAppIconSet(null);
    }

    if (
      previous?.providerId !== provider.id ||
      (provider.id === 'slack' && !hasConfiguredValues)
    ) {
      setSlackCreateWithConfigToken(false);
    }

    previousConfiguredValues.current = {
      providerId: provider.id,
      hasConfiguredValues,
    };
  }, [provider.id, hasConfiguredValues]);

  const hasEditableFields = visibleFields.some(
    (field) => !field.runtimeSatisfied,
  );
  const providerOwnsActions =
    provider.id === 'slack' &&
    (!hasConfiguredValues ||
      slackCreateWithConfigToken ||
      Boolean(createdSlackAppSettingsUrl));

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
  const teamsAppPackageUnavailableReason = isMicrosoftProvider
    ? getTeamsAppPackageUnavailableReason(enteredTeamsBotAppId)
    : null;

  // AgentMail replaces the free-text inbox field with a chooser fed by the
  // account's inbox list, so that field is pulled out of the generic setup
  // fields and rendered below (unless an env var pins it at runtime).
  const agentMailInboxField =
    provider.id === 'agentmail'
      ? provider.fields.find(
          (field) => field.envVarName === 'R_AGENTMAIL_INBOX_ID',
        )
      : undefined;
  const agentMailChooserActive = Boolean(
    agentMailInboxField && !agentMailInboxField.runtimeSatisfied,
  );
  const setupExperienceProvider = agentMailChooserActive
    ? {
        ...provider,
        fields: provider.fields.filter(
          (field) => field.envVarName !== 'R_AGENTMAIL_INBOX_ID',
        ),
      }
    : provider;
  const agentMailApiKeyField =
    provider.id === 'agentmail'
      ? provider.fields.find(
          (field) => field.envVarName === 'R_AGENTMAIL_API_KEY',
        )
      : undefined;
  const agentMailKeyConfigured = Boolean(
    agentMailApiKeyField &&
    (agentMailApiKeyField.runtimeSatisfied ||
      (agentMailApiKeyField.savedSatisfied &&
        !clearedSavedValues['R_AGENTMAIL_API_KEY'])),
  );

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
          provider.id === 'agentmail' ? (
            <Mail className="size-4 shrink-0" />
          ) : (
            <BrandIcon
              icon={getProviderIconId(provider.id)}
              name=""
              className="size-4 shrink-0"
            />
          )
        }
        title={provider.label}
        action={
          provider.id === 'slack' ? (
            <div className="flex items-center gap-2">
              <SlackManifestUpdateDialog />
              <SlackWorkspaceAuthButton configured={hasConfiguredValues} />
            </div>
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
              provider={setupExperienceProvider}
              values={values}
              publicOrigin={publicOrigin}
              disabled={savePending}
              editingSavedValues={editingSavedValues}
              clearedSavedValues={clearedSavedValues}
              teamsAppPackageHref={teamsAppPackageHref}
              teamsAppPackageUnavailableReason={
                teamsAppPackageUnavailableReason
              }
              createdSlackAppSettingsUrl={createdSlackAppSettingsUrl}
              createdSlackAppIconSet={createdSlackAppIconSet}
              createSlackAppPending={createSlackApp.isPending}
              slackCreateWithConfigToken={slackCreateWithConfigToken}
              surface="settings"
              envVarsInfoNote={
                !provider.runtimeSatisfied && provider.id === 'telegram'
                  ? 'Roomote generates a webhook secret automatically, registers the webhook when you save, and defaults Telegram task launches to the admin who saves this configuration.'
                  : !provider.runtimeSatisfied && provider.id === 'discord'
                    ? 'Roomote validates the token, derives the bot identity, and registers /new, /goal, /link, and /help when you save.'
                    : !provider.runtimeSatisfied && provider.id === 'agentmail'
                      ? 'Roomote validates the API key, adopts or provisions an inbox, and registers the AgentMail webhook when you save. The key needs these AgentMail permissions (or full access): inbox_read, inbox_create, inbox_update, webhook_read, webhook_create, webhook_update, webhook_delete, message_read, message_send.'
                      : undefined
              }
              onCreateSlackApp={(configToken) =>
                createSlackApp.mutate({ configToken })
              }
              onSlackCreateWithConfigTokenChange={setSlackCreateWithConfigToken}
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

            {agentMailChooserActive && agentMailInboxField ? (
              <AgentMailInboxChooser
                enteredApiKey={values['R_AGENTMAIL_API_KEY']?.trim() ?? ''}
                keyConfigured={agentMailKeyConfigured}
                value={values['R_AGENTMAIL_INBOX_ID'] ?? ''}
                savedSatisfied={agentMailInboxField.savedSatisfied}
                disabled={savePending}
                onChange={(address) => {
                  setValues((current) => ({
                    ...current,
                    R_AGENTMAIL_INBOX_ID: address,
                  }));
                  if (agentMailInboxField.savedSatisfied) {
                    setClearedSavedValues((current) => ({
                      ...current,
                      R_AGENTMAIL_INBOX_ID: address.length === 0,
                    }));
                  }
                }}
              />
            ) : null}

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
              {provider.id === 'discord' && provider.discord && (
                <DiscordSetupStatus status={provider.discord} />
              )}
              {provider.id === 'agentmail' && provider.agentmail && (
                <AgentMailSetupStatus status={provider.agentmail} />
              )}
              {provider.id === 'microsoft' &&
                (hasConfiguredValues || teamsBotConfigured) && (
                  <TeamsBotStatus />
                )}
            </div>

            {providerOwnsActions ? null : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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

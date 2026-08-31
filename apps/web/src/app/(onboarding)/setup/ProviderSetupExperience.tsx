'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES,
  type SetupAuthStatus,
} from '@roomote/types';

import {
  ArrowLeft,
  BasicTooltip,
  Check,
  CopyIconButton,
  Download,
  EnvVarsInfoNote,
  ExternalLink,
  Input,
  Button,
  Sparkles,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { NumberedStep } from './NumberedStep';
import { ProviderSetupInstructions } from './ProviderSetupInstructions';
import { getProviderSetupCopy } from './providerSetupCopy';

type ProviderSetupExperienceProvider =
  | SetupAuthStatus['providers'][number]
  | {
      id:
        | SetupAuthStatus['providers'][number]['id']
        | 'telegram'
        | 'discord'
        | 'agentmail';
      label: string;
      fields: SetupAuthStatus['providers'][number]['fields'];
      runtimeSatisfied: boolean;
      savedSatisfied: boolean;
      setupSatisfied: boolean;
    };

type ProviderStatus = ProviderSetupExperienceProvider;
type ProviderFieldStatus = ProviderStatus['fields'][number];

const MASKED_VALUE = '••••••••••••••••••••••••••••';

const MICROSOFT_SETUP_HIDDEN_ENV_VAR_NAMES = new Set([
  ...Object.keys(MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES),
  'R_TEAMS_BOT_NAME',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_OAUTH_SCOPE',
]);

const TELEGRAM_SETUP_HIDDEN_ENV_VAR_NAMES = new Set([
  'R_TELEGRAM_WEBHOOK_SECRET',
]);

export const MICROSOFT_APP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MICROSOFT_APP_ID_FIELD_ENV_VAR_NAMES = new Set([
  'R_MICROSOFT_CLIENT_ID',
  'R_TEAMS_BOT_APP_ID',
]);

/**
 * Inline warning shown directly under an app-id input whose value cannot be an
 * Entra client id. The package-download note further down explains the same
 * problem, but the feedback belongs at the field where the value was typed.
 */
function getMicrosoftAppIdFormatWarning(
  providerId: string,
  envVarName: string,
  value: string,
): string | null {
  if (
    providerId !== 'microsoft' ||
    !MICROSOFT_APP_ID_FIELD_ENV_VAR_NAMES.has(envVarName)
  ) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || MICROSOFT_APP_ID_PATTERN.test(trimmed)) {
    return null;
  }

  return "This doesn't look like an Entra app ID — expected a GUID like 00000000-0000-0000-0000-000000000000.";
}

/**
 * The Teams app package embeds the bot app id, so a value that is not a GUID
 * cannot produce a usable package. Explain that instead of leaving the
 * download button dead with no reason.
 */
export function getTeamsAppPackageUnavailableReason(
  enteredAppId: string,
): string | null {
  const appId = enteredAppId.trim();

  if (!appId || MICROSOFT_APP_ID_PATTERN.test(appId)) {
    return null;
  }

  return 'That App (Client) ID is not a valid GUID, so Roomote cannot pre-fill the Teams app package. Copy the Application (client) ID from the Entra app registration overview — it looks like 00000000-0000-0000-0000-000000000000.';
}

export function getSetupVisibleFields(
  provider: ProviderStatus | null,
  options: { showMicrosoftAdvancedConfig?: boolean } = {},
) {
  if (!provider) {
    return [];
  }

  if (provider.id === 'microsoft' && !options.showMicrosoftAdvancedConfig) {
    return provider.fields.filter(
      (field) => !MICROSOFT_SETUP_HIDDEN_ENV_VAR_NAMES.has(field.envVarName),
    );
  }

  if (provider.id === 'telegram') {
    return provider.fields.filter(
      (field) => !TELEGRAM_SETUP_HIDDEN_ENV_VAR_NAMES.has(field.envVarName),
    );
  }

  return provider.fields;
}

export function getSetupEffectiveFieldValue({
  provider,
  field,
  values,
}: {
  provider: ProviderStatus | null;
  field: ProviderFieldStatus;
  values: Record<string, string>;
}) {
  const ownValue = values[field.envVarName];

  if (
    (ownValue?.length ?? 0) > 0 ||
    (ownValue !== undefined && field.defaultValue !== undefined)
  ) {
    return ownValue ?? '';
  }

  if (field.secret !== true && field.savedValue?.trim()) {
    return field.savedValue;
  }

  if (
    provider?.id !== 'microsoft' ||
    field.runtimeSatisfied ||
    field.savedSatisfied
  ) {
    return '';
  }

  const sourceEnvVarName =
    MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES[
      field.envVarName as keyof typeof MICROSOFT_SINGLE_APP_TEAMS_BOT_FIELD_SOURCES
    ];

  return sourceEnvVarName
    ? (values[sourceEnvVarName] ?? field.defaultValue ?? '')
    : (field.defaultValue ?? '');
}

export function getSetupSubmitValues({
  provider,
  values,
  showMicrosoftAdvancedConfig,
}: {
  provider: ProviderStatus | null;
  values: Record<string, string>;
  showMicrosoftAdvancedConfig?: boolean;
}) {
  if (!provider) {
    return values;
  }

  const nextValues = { ...values };

  for (const field of getSetupVisibleFields(provider, {
    showMicrosoftAdvancedConfig,
  })) {
    if (nextValues[field.envVarName]?.trim()) {
      continue;
    }

    const copiedValue = getSetupEffectiveFieldValue({
      provider,
      field,
      values,
    });

    if (copiedValue.trim()) {
      nextValues[field.envVarName] = copiedValue;
    }
  }

  // Do not materialize inferred Teams bot env vars from Microsoft single-app
  // credentials. Runtime resolution already borrows Microsoft values, and
  // writing snapshots here locks derived config so client-id updates drift.

  return nextValues;
}

function InstructionUrl({ heading, url }: { heading: string; url: string }) {
  return <InstructionUrlContent heading={heading} url={url} />;
}

function InstructionUrlContent({
  heading,
  url,
  disabled = false,
}: {
  heading: string;
  url: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1 flex gap-2 items-center">
      <p className="font-semibold text-foreground text-sm w-45 shrink-0">
        {heading}
      </p>
      <div className="flex items-center gap-2 rounded-md border border-black px-2 py-1 overflow-hidden justify-end">
        <BasicTooltip content={url}>
          <span className="text-[0.8em] text-foreground truncate">{url}</span>
        </BasicTooltip>
        <CopyIconButton
          aria-label={`Copy ${heading}`}
          content={url}
          disabled={disabled}
          tooltip={`Copy ${heading}`}
        />
      </div>
    </div>
  );
}

function ProviderFields({
  provider,
  fields,
  values,
  editingSavedValues,
  clearedSavedValues,
  disabled,
  onValueChange,
  onEditingSavedValueChange,
  onClearedSavedValueChange,
}: {
  provider: ProviderStatus;
  fields: ProviderFieldStatus[];
  values: Record<string, string>;
  editingSavedValues: Record<string, boolean>;
  clearedSavedValues: Record<string, boolean>;
  disabled: boolean;
  onValueChange: (envVarName: string, value: string) => void;
  onEditingSavedValueChange: (envVarName: string, editing: boolean) => void;
  onClearedSavedValueChange: (envVarName: string, cleared: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      {fields.map((field) => {
        const explicitValue = values[field.envVarName] ?? '';
        const value = getSetupEffectiveFieldValue({ provider, field, values });
        const isSecretField = field.secret === true;
        const shouldShowSavedValueMask =
          isSecretField &&
          !field.runtimeSatisfied &&
          field.savedSatisfied &&
          explicitValue.length === 0 &&
          !clearedSavedValues[field.envVarName] &&
          !editingSavedValues[field.envVarName];
        const formatWarning =
          !isSecretField && !field.runtimeSatisfied
            ? getMicrosoftAppIdFormatWarning(
                provider.id,
                field.envVarName,
                value,
              )
            : null;

        return (
          <div
            key={field.envVarName}
            className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center max-w-xl"
          >
            <div className="space-y-1">
              <div className="text-sm font-medium">
                {field.label}
                {field.required === false ? ' (optional)' : ''}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Input
                  secret={isSecretField && !field.runtimeSatisfied}
                  className="font-mono"
                  value={
                    isSecretField && field.runtimeSatisfied
                      ? MASKED_VALUE
                      : shouldShowSavedValueMask
                        ? MASKED_VALUE
                        : value
                  }
                  onFocus={() => {
                    if (shouldShowSavedValueMask) {
                      onEditingSavedValueChange(field.envVarName, true);
                    }
                  }}
                  onBlur={() => {
                    if (field.savedSatisfied && explicitValue.length === 0) {
                      onEditingSavedValueChange(field.envVarName, false);
                    }
                  }}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    onValueChange(field.envVarName, nextValue);

                    if (field.savedSatisfied) {
                      onClearedSavedValueChange(
                        field.envVarName,
                        nextValue.length === 0,
                      );
                    }
                  }}
                  placeholder={
                    isSecretField && field.runtimeSatisfied ? '' : field.label
                  }
                  disabled={disabled || field.runtimeSatisfied}
                  data-1p-ignore
                />
                {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
              </div>
              {formatWarning ? (
                <p className="mt-1 text-sm text-amber-600">{formatWarning}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type ProviderSetupExperienceProps = {
  provider: ProviderStatus;
  values: Record<string, string>;
  publicOrigin: string;
  disabled: boolean;
  editingSavedValues: Record<string, boolean>;
  clearedSavedValues: Record<string, boolean>;
  teamsAppPackageHref: string | null;
  /**
   * Why the pre-filled package cannot be built yet (e.g. the entered App
   * (Client) ID is not a GUID). Without it the download button just goes dead
   * with nothing to act on.
   */
  teamsAppPackageUnavailableReason?: string | null;
  createdSlackAppSettingsUrl?: string | null;
  createdSlackAppIconSet?: boolean | null;
  createSlackAppPending?: boolean;
  showMicrosoftAdvancedConfig?: boolean;
  /**
   * When true, Slack shows the config-token create flow even if credentials are
   * already saved (settings recreate path). Parent surfaces own the toggle so
   * Save/Remove can hide while create is active.
   */
  slackCreateWithConfigToken?: boolean;
  surface?: 'setup' | 'settings';
  envVarsInfoNote?: React.ReactNode;
  onCreateSlackApp?: (configToken: string) => void;
  onSlackCreateWithConfigTokenChange?: (active: boolean) => void;
  onToggleMicrosoftAdvancedConfig?: () => void;
  onValueChange: (envVarName: string, value: string) => void;
  onEditingSavedValueChange: (envVarName: string, editing: boolean) => void;
  onClearedSavedValueChange: (envVarName: string, cleared: boolean) => void;
  onBack?: () => void;
};

function SettingsEnvVarsInfoNote({
  runtimeConfigured,
  children,
}: {
  runtimeConfigured: boolean;
  children?: React.ReactNode;
}) {
  return (
    <EnvVarsInfoNote runtimeConfigured={runtimeConfigured}>
      {children}
    </EnvVarsInfoNote>
  );
}

function ProviderSetupTitle({
  surface,
  text,
}: {
  surface?: 'setup' | 'settings';
  text: string;
}) {
  return surface === 'settings' ? null : <StepTitle text={text} />;
}

function SlackConfigTokenCreateExperience({
  canCancelToConfigured,
  ...props
}: ProviderSetupExperienceProps & {
  canCancelToConfigured: boolean;
}) {
  const [configToken, setConfigToken] = useState('');
  const createSlackAppPending = props.createSlackAppPending === true;
  const createSlackAppDisabled =
    !props.onCreateSlackApp || props.disabled || createSlackAppPending;
  const submitConfigToken = () => {
    const normalizedConfigToken = configToken.trim();

    if (createSlackAppDisabled || !normalizedConfigToken) {
      return;
    }

    props.onCreateSlackApp?.(normalizedConfigToken);
  };
  const handleBack = () => {
    if (canCancelToConfigured) {
      props.onSlackCreateWithConfigTokenChange?.(false);
      return;
    }

    props.onBack?.();
  };
  const showBack = canCancelToConfigured || Boolean(props.onBack);

  return (
    <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
      <ProviderSetupTitle surface={props.surface} text="Create Slack app" />

      <div className="space-y-4 max-w-xl">
        <p>
          Because Roomote is self-hosted, we can&apos;t offer you an
          out-of-the-box Slack app – you need your own. Creating it is dead
          simple, though.
        </p>
        <NumberedStep number={1}>
          <p className="font-semibold">Get an app token.</p>
          <div className="space-y-3 max-w-xl">
            <p className="text-sm text-muted-foreground">
              Go to the{' '}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline font-semibold"
              >
                Slack Apps portal
                <ExternalLink className="inline size-3 -mt-1 ml-1" />
              </a>{' '}
              → Your App Configuration Tokens (at the bottom of the page) →{' '}
              <span className="font-semibold">Generate Token</span>, picking the
              workspace you want to connect.
            </p>
          </div>
        </NumberedStep>
        <NumberedStep number={2}>
          <p className="font-semibold">Copy it....</p>
          <p className="text-sm text-muted-foreground">...and paste it here:</p>
          <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center max-w-xl">
            <div className="text-sm font-medium">Access token</div>
            <Input
              secret
              className="font-mono"
              aria-label="App configuration token"
              value={configToken}
              onChange={(event) => setConfigToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitConfigToken();
                }
              }}
              placeholder="xoxe.xoxp-..."
              disabled={props.disabled || createSlackAppPending}
              data-1p-ignore
            />
          </div>
        </NumberedStep>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
        {showBack ? (
          <Button
            type="button"
            variant="outline"
            onClick={handleBack}
            disabled={createSlackAppPending}
          >
            <ArrowLeft />
            Back
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={submitConfigToken}
          disabled={createSlackAppDisabled || configToken.trim().length === 0}
        >
          {createSlackAppPending ? <Spinner /> : <Sparkles />}
          Create Slack app
        </Button>
      </div>
    </div>
  );
}

function SlackConfiguredCredentialsExperience(
  props: ProviderSetupExperienceProps,
) {
  const fields = getSetupVisibleFields(props.provider);
  const canCreateWithConfigToken = Boolean(props.onCreateSlackApp);

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
      <ProviderSetupTitle surface={props.surface} text="Configure Slack app" />

      <div className="space-y-4 max-w-xl">
        <p className="text-sm text-muted-foreground">
          Credentials for the Slack app Roomote uses for sign-in and messaging.
          {canCreateWithConfigToken ? (
            <>
              {' '}
              To replace them with a newly created app, use a configuration
              token.
            </>
          ) : null}
        </p>
        <ProviderFields fields={fields} {...props} />
        {props.surface === 'settings' ? (
          <SettingsEnvVarsInfoNote
            runtimeConfigured={props.provider.runtimeSatisfied}
          />
        ) : null}
        {canCreateWithConfigToken ? (
          <div className="pt-1">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
              onClick={() => props.onSlackCreateWithConfigTokenChange?.(true)}
              disabled={props.disabled || props.createSlackAppPending === true}
            >
              Create a new Slack app with a configuration token
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SlackSetupExperience(props: ProviderSetupExperienceProps) {
  const createdSlackAppSettingsUrl = props.createdSlackAppSettingsUrl ?? null;
  const createdSlackAppIconSet = props.createdSlackAppIconSet === true;
  const hasConfiguredValues =
    props.provider.runtimeSatisfied || props.provider.savedSatisfied;
  const showConfigTokenCreate =
    Boolean(props.slackCreateWithConfigToken) || !hasConfiguredValues;

  if (createdSlackAppSettingsUrl) {
    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <ProviderSetupTitle surface={props.surface} text="Finish Slack app" />

        <div className="space-y-4 max-w-xl">
          {createdSlackAppIconSet ? (
            <p>
              Your Slack app is ready. Open{' '}
              <a
                href={createdSlackAppSettingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline font-semibold"
              >
                the app
              </a>{' '}
              if you want to review its settings, then continue to connect it to
              your workspace.
            </p>
          ) : (
            <p>
              Your Slack app is ready. Adding a logo is optional: open{' '}
              <a
                href={createdSlackAppSettingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline font-semibold"
              >
                the app
              </a>
              , scroll down to App icon, and upload{' '}
              <a
                href="/api/setup/roomote-logo"
                download
                className="text-foreground underline font-semibold"
              >
                the Roomote logo
              </a>
              .
            </p>
          )}
        </div>
      </div>
    );
  }

  if (showConfigTokenCreate) {
    return (
      <SlackConfigTokenCreateExperience
        {...props}
        canCancelToConfigured={
          hasConfiguredValues && Boolean(props.slackCreateWithConfigToken)
        }
      />
    );
  }

  return <SlackConfiguredCredentialsExperience {...props} />;
}

function MicrosoftSetupExperience(props: ProviderSetupExperienceProps) {
  const fields = getSetupVisibleFields(props.provider, {
    showMicrosoftAdvancedConfig: props.showMicrosoftAdvancedConfig,
  });
  const baseFields = getSetupVisibleFields(props.provider);
  const advancedFields = props.provider.fields.filter((field) =>
    MICROSOFT_SETUP_HIDDEN_ENV_VAR_NAMES.has(field.envVarName),
  );
  const providerSetupCopy = getProviderSetupCopy(props.provider.id);
  const webRedirectUri = `${props.publicOrigin}/api/auth/oauth2/callback/microsoft-entra-id`;
  const teamsWebhookUrl = `${props.publicOrigin}/api/webhooks/teams`;
  const teamsAppValuesComplete = fields.every((field) => {
    if (field.required === false || field.runtimeSatisfied) {
      return true;
    }

    if (field.savedSatisfied && !props.clearedSavedValues[field.envVarName]) {
      return true;
    }

    return (
      getSetupEffectiveFieldValue({
        provider: props.provider,
        field,
        values: props.values,
      }).trim().length > 0
    );
  });
  const teamsAppPackageAvailable =
    Boolean(props.teamsAppPackageHref) &&
    (teamsAppValuesComplete || props.surface === 'settings');
  const pendingStepClassName = teamsAppPackageAvailable
    ? undefined
    : 'opacity-50';

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
      <ProviderSetupTitle
        surface={props.surface}
        text="Configure Microsoft Teams app"
      />

      <p className="max-w-xl">
        First, let&apos;s take a deep breath together – MS doesn&apos;t make
        this easy. Second, you may need to ask an admin to do some of this for
        you.
      </p>

      <NumberedStep number={1} className="mt-6">
        <p className="font-semibold">Create a Microsoft Entra app.</p>
        <div className="space-y-3 max-w-xl">
          <p className="text-sm text-muted-foreground">
            In{' '}
            <a
              href={providerSetupCopy.creationHref}
              target="_blank"
              className="text-foreground underline font-semibold"
              rel="noopener noreferrer"
            >
              Azure App registrations{' '}
              <ExternalLink className="inline size-3 -mt-1 ml-1" />
            </a>{' '}
            click New registration → give it a name and the URI below →
            Register.
          </p>
          <InstructionUrl heading="Web redirect URI" url={webRedirectUri} />
        </div>
      </NumberedStep>

      <NumberedStep number={2}>
        <p className="font-semibold">
          Enter the Microsoft Entra app generated values.
        </p>
        <p className="text-sm text-muted-foreground">
          Paste the values below. For the secret, you need to create a client
          secret first.
        </p>
        <ProviderFields fields={baseFields} {...props} />
        {advancedFields.length > 0 && props.onToggleMicrosoftAdvancedConfig ? (
          <div className="pt-1">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
              onClick={props.onToggleMicrosoftAdvancedConfig}
            >
              {props.showMicrosoftAdvancedConfig
                ? 'Hide advanced config'
                : 'Show advanced config'}
            </button>
          </div>
        ) : null}
        {props.showMicrosoftAdvancedConfig ? (
          <ProviderFields fields={advancedFields} {...props} />
        ) : null}
        {props.surface === 'settings' ? (
          <SettingsEnvVarsInfoNote
            runtimeConfigured={props.provider.runtimeSatisfied}
          />
        ) : null}
      </NumberedStep>

      <NumberedStep number={3} className={pendingStepClassName}>
        <div className="space-y-2">
          <p className="font-semibold">Upload Roomote to Microsoft Teams.</p>
          <p className="text-sm text-muted-foreground">
            Download your pre-filled Teams app package (manifest + icons), go to
            the{' '}
            <a
              href="https://dev.teams.microsoft.com/home"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline font-semibold"
            >
              Teams Developer Portal{' '}
              <ExternalLink className="inline size-3 -mt-1 ml-1" />
            </a>{' '}
            → Import App (you may need to ask your admin to do that).
          </p>
          {teamsAppPackageAvailable && props.teamsAppPackageHref ? (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={props.teamsAppPackageHref} download>
                  <Download />
                  Download Teams app package
                </a>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled>
                  <Download />
                  Download Teams app package
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {props.teamsAppPackageUnavailableReason ??
                  'Enter the values above to build a pre-filled package.'}
              </p>
            </div>
          )}
        </div>
      </NumberedStep>

      <NumberedStep number={4} className={pendingStepClassName}>
        <p className="font-semibold">
          Add the Teams bot capability to that app.
        </p>
        <div className="space-y-3 max-w-xl">
          <p className="text-sm text-muted-foreground">
            Open the imported Roomote app. Then Configure → App Features → Bot.
            Use the same Client ID for the bot app ID. Set this messaging
            endpoint for the bot:
          </p>
          <InstructionUrlContent
            heading="Bot messaging endpoint"
            url={teamsWebhookUrl}
            disabled={!teamsAppPackageAvailable}
          />
        </div>
      </NumberedStep>

      <NumberedStep number={5} className={pendingStepClassName}>
        <p className="font-semibold">Add the app</p>
        <p className="text-sm text-muted-foreground">
          Click on &quot;Preview in Teams&quot; → Add
        </p>
      </NumberedStep>
    </div>
  );
}

function GenericSetupExperience(props: ProviderSetupExperienceProps) {
  const providerSetupCopy = getProviderSetupCopy(props.provider.id);
  const providerSetupLabel =
    providerSetupCopy?.setupLabel ?? `${props.provider.label} app`;
  const fields = getSetupVisibleFields(props.provider);

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
      <ProviderSetupTitle
        surface={props.surface}
        text={`Configure ${providerSetupLabel}`}
      />

      <NumberedStep number={1} className="mt-6">
        <p className="font-semibold">
          Create a new {providerSetupCopy.setupLabel}.
          <Button
            variant="outline"
            size="sm"
            className="ml-2 h-auto px-2 py-0.75"
          >
            <a
              href={providerSetupCopy.creationHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Go <ExternalLink className="inline size-3 -mt-1 ml-1" />
            </a>
          </Button>
        </p>
        <p className="text-sm text-muted-foreground">
          If you need our logo,{' '}
          <Link
            className="underline underline-offset-4 hover:text-foreground"
            href="/api/setup/roomote-logo"
          >
            download here
          </Link>
          .
        </p>
      </NumberedStep>

      <NumberedStep number={2}>
        <ProviderSetupInstructions
          providerId={props.provider.id}
          publicOrigin={props.publicOrigin}
          surface="setup"
        />
      </NumberedStep>

      <NumberedStep number={3}>
        <p className="font-semibold">Enter the values below:</p>
        <ProviderFields fields={fields} {...props} />
        {props.surface === 'settings' ? (
          <SettingsEnvVarsInfoNote
            runtimeConfigured={props.provider.runtimeSatisfied}
          >
            {props.envVarsInfoNote}
          </SettingsEnvVarsInfoNote>
        ) : null}
      </NumberedStep>
    </div>
  );
}

const PROVIDER_SETUP_EXPERIENCES: Partial<
  Record<ProviderSetupExperienceProvider['id'], typeof GenericSetupExperience>
> = {
  slack: SlackSetupExperience,
  microsoft: MicrosoftSetupExperience,
};

export function ProviderSetupExperience(props: ProviderSetupExperienceProps) {
  const Component =
    PROVIDER_SETUP_EXPERIENCES[props.provider.id] ?? GenericSetupExperience;

  return <Component {...props} />;
}

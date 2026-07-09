'use client';

import Link from 'next/link';
import type { SetupAuthStatus } from '@roomote/types';

import { buildSlackManifestPrefillUrl } from '@/lib/slack-app-manifest';
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
  Pencil,
  Sparkles,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { ProviderSetupInstructions } from './ProviderSetupInstructions';
import { getProviderSetupCopy } from './providerSetupCopy';

export type ProviderSetupExperienceProvider =
  | SetupAuthStatus['providers'][number]
  | {
      id: SetupAuthStatus['providers'][number]['id'] | 'telegram';
      label: string;
      fields: SetupAuthStatus['providers'][number]['fields'];
      runtimeSatisfied: boolean;
      savedSatisfied: boolean;
      setupSatisfied: boolean;
    };

type ProviderStatus = ProviderSetupExperienceProvider;
type ProviderFieldStatus = ProviderStatus['fields'][number];

const MASKED_VALUE = '••••••••••••••••••••••••••••';

const MICROSOFT_SINGLE_APP_BOT_FIELD_SOURCES: Record<string, string> = {
  TEAMS_BOT_APP_ID: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  TEAMS_BOT_APP_PASSWORD: 'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  TEAMS_BOT_TENANT_ID: 'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
};

const MICROSOFT_SETUP_HIDDEN_ENV_VAR_NAMES = new Set([
  ...Object.keys(MICROSOFT_SINGLE_APP_BOT_FIELD_SOURCES),
  'TEAMS_BOT_TOKEN_ENDPOINT',
  'TEAMS_BOT_OAUTH_SCOPE',
]);

export function getSetupVisibleFields(provider: ProviderStatus | null) {
  if (!provider) {
    return [];
  }

  if (provider.id !== 'microsoft') {
    return provider.fields;
  }

  return provider.fields.filter(
    (field) => !MICROSOFT_SETUP_HIDDEN_ENV_VAR_NAMES.has(field.envVarName),
  );
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
  const ownValue = values[field.envVarName] ?? '';

  if (ownValue.length > 0) {
    return ownValue;
  }

  if (
    provider?.id !== 'microsoft' ||
    field.runtimeSatisfied ||
    field.savedSatisfied
  ) {
    return '';
  }

  const sourceEnvVarName =
    MICROSOFT_SINGLE_APP_BOT_FIELD_SOURCES[field.envVarName];

  return sourceEnvVarName ? (values[sourceEnvVarName] ?? '') : '';
}

export function getSetupSubmitValues({
  provider,
  values,
}: {
  provider: ProviderStatus | null;
  values: Record<string, string>;
}) {
  if (!provider) {
    return values;
  }

  const nextValues = { ...values };

  for (const field of getSetupVisibleFields(provider)) {
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

  if (provider.id === 'microsoft') {
    for (const [envVarName, sourceEnvVarName] of Object.entries(
      MICROSOFT_SINGLE_APP_BOT_FIELD_SOURCES,
    )) {
      if (nextValues[envVarName]?.trim()) {
        continue;
      }

      const copiedValue = values[sourceEnvVarName];

      if (copiedValue?.trim()) {
        nextValues[envVarName] = copiedValue;
      }
    }
  }

  return nextValues;
}

function NumberedStep({
  number,
  children,
  className,
}: {
  number: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex gap-2 items-start ${className ?? ''}`}>
      <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
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
      <div className="flex items-center gap-2 rounded-md border border-black px-2 py-1.5 overflow-hidden justify-end">
        <BasicTooltip content={url}>
          <span className="font-mono text-xs text-foreground truncate">
            {url}
          </span>
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
        const shouldShowSavedValueMask =
          !field.runtimeSatisfied &&
          field.savedSatisfied &&
          explicitValue.length === 0 &&
          !clearedSavedValues[field.envVarName] &&
          !editingSavedValues[field.envVarName];

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
                  secret={field.secret && !field.runtimeSatisfied}
                  className="font-mono"
                  value={
                    field.runtimeSatisfied
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
                  placeholder={field.runtimeSatisfied ? '' : field.label}
                  disabled={disabled || field.runtimeSatisfied}
                  data-1p-ignore
                />
                {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
              </div>
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
  showManualSlackValues: boolean;
  surface?: 'setup' | 'settings';
  envVarsInfoNote?: React.ReactNode;
  onShowManualSlackValues: () => void;
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

function SlackSetupExperience(props: ProviderSetupExperienceProps) {
  const slackManifestPrefillUrl = buildSlackManifestPrefillUrl({
    publicOrigin: props.publicOrigin,
  });

  if (
    !props.showManualSlackValues &&
    !props.provider.runtimeSatisfied &&
    !props.provider.savedSatisfied
  ) {
    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <ProviderSetupTitle surface={props.surface} text="Create Slack app" />

        <div className="space-y-3 max-w-xl">
          <p>
            Because Roomote is self-hosted, we can&apos;t offer you an
            out-of-the-box Slack app – you need to create your own.
          </p>
          <p>
            Roomote can create it for you automatically, and then you can enter
            the config values manually.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          {props.onBack ? (
            <Button type="button" variant="outline" onClick={props.onBack}>
              <ArrowLeft />
              Back
            </Button>
          ) : null}
          <Button asChild>
            <a
              href={slackManifestPrefillUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={props.onShowManualSlackValues}
            >
              <Sparkles />
              Create Slack app
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={props.onShowManualSlackValues}
          >
            <Pencil />
            Enter values manually
          </Button>
        </div>
      </div>
    );
  }

  return <GenericSetupExperience {...props} />;
}

function MicrosoftSetupExperience(props: ProviderSetupExperienceProps) {
  const fields = getSetupVisibleFields(props.provider);
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

      <NumberedStep number={1} className="mt-6">
        <p className="font-semibold">Create a Microsoft Entra app.</p>
        <div className="space-y-3 max-w-xl">
          <p className="text-sm text-muted-foreground">
            In Azure App registrations, click New registration → give it a name
            and the URI below → Register. Register one single-tenant app for
            both Microsoft sign-in and the Teams bot. Add this Web redirect URI
            under Authentication, then create a client secret.
          </p>
          <InstructionUrl heading="Web redirect URI" url={webRedirectUri} />
        </div>
        <div className="mt-2">
          <Button variant="outline" size="sm">
            <a
              href={providerSetupCopy.creationHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Go <ExternalLink className="inline size-3 -mt-1 ml-1" />
            </a>
          </Button>
        </div>
      </NumberedStep>

      <NumberedStep number={2}>
        <p className="font-semibold">
          Enter the Microsoft app generated values.
        </p>
        <ProviderFields fields={fields} {...props} />
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
            the Teams Developer Portal → Import App.
          </p>
          {teamsAppPackageAvailable && props.teamsAppPackageHref ? (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={props.teamsAppPackageHref} download>
                  <Download />
                  Download Teams app package
                </a>
              </Button>
              <Button variant="outline" size="sm">
                <a
                  href="https://dev.teams.microsoft.com/home"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Go <ExternalLink className="inline size-3 -mt-1 ml-1" />
                </a>
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled>
                <Download />
                Download Teams app package
              </Button>
              <Button variant="outline" size="sm" disabled>
                Go <ExternalLink className="inline size-3 -mt-1 ml-1" />
              </Button>
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

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  getSetupSourceControlVisibleFields,
  type SetupSourceControlStatus,
  type SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  Button,
  Check,
  CopyIconButton,
  ExternalLink,
  Input,
  Label,
  Pencil,
  Sparkles,
  Spinner,
} from '@/components/system';
import { useCreateGitHubAppManifest } from '@/hooks/github';
import {
  useAdoLinkedAccount,
  useAuthenticateAdoAccount,
} from '@/hooks/linked-accounts';

import { StepTitle } from './StepTitle';
import { getSourceControlSetupCopy } from './sourceControlSetupCopy';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

type SourceControlField =
  SetupSourceControlStatus['providers'][number]['fields'][number];

function isSecretSourceControlField(field: Pick<SourceControlField, 'secret'>) {
  return field.secret === true;
}

function getNonSecretFieldInitialValues(
  fields: readonly SourceControlField[],
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const field of fields) {
    if (isSecretSourceControlField(field) || field.runtimeSatisfied) {
      continue;
    }

    const savedValue = field.savedValue?.trim();
    if (savedValue) {
      next[field.envVarName] = savedValue;
    }
  }

  return next;
}

function filterValuesToFields(
  fields: readonly SourceControlField[],
  values: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(values, field.envVarName)) {
      next[field.envVarName] = values[field.envVarName] ?? '';
    }
  }

  return next;
}

type GitHubAppManifestForm = {
  postTarget: string;
  values: {
    manifest: string;
  };
};

export function StepSourceControlConfig({
  sourceControlSetup,
  selectedProviderId,
  onContinue,
  onBack,
}: {
  sourceControlSetup: SetupSourceControlStatus;
  selectedProviderId?: SourceControlProvider | null;
  onContinue: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const effectiveSelectedProviderId =
    selectedProviderId ??
    sourceControlSetup.selectedProvider ??
    sourceControlSetup.preselectedProvider;
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [showManualGitHubValues, setShowManualGitHubValues] = useState(false);
  const [showAdoAdvancedConfig, setShowAdoAdvancedConfig] = useState(false);
  const [adoAuthMode, setAdoAuthMode] = useState<'pat' | 'entra' | 'delegated'>(
    'pat',
  );
  const adoLinkedAccount = useAdoLinkedAccount();
  const authenticateAdoAccount = useAuthenticateAdoAccount();
  const [githubOrganization, setGithubOrganization] = useState('');
  const [manifestForm, setManifestForm] =
    useState<GitHubAppManifestForm | null>(null);
  const manifestFormRef = useRef<HTMLFormElement | null>(null);
  const saveSourceControlConfig = useMutation(
    trpc.setupNew.saveSourceControlConfig.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.ado.queryKey(),
        });
        if (adoAuthMode === 'delegated' && !adoLinkedAccount.data?.account) {
          authenticateAdoAccount.mutate(
            `${window.location.pathname}${window.location.search}`,
          );
          return;
        }
        onContinue();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const createGitHubAppManifest = useCreateGitHubAppManifest({
    onSuccess: (result) => {
      if (result.success) {
        setManifestForm(result);
      } else {
        toast.error(result.error);
      }
    },
    onError: () =>
      toast.error('Failed to start GitHub App creation. Please try again.'),
  });

  const selectedProvider = useMemo(
    () =>
      sourceControlSetup.providers.find(
        (provider) => provider.provider === effectiveSelectedProviderId,
      ),
    [sourceControlSetup.providers, effectiveSelectedProviderId],
  );
  const isAdo = selectedProvider?.provider === 'ado';
  const providerFields = useMemo(
    () => selectedProvider?.fields ?? [],
    [selectedProvider],
  );
  const baseFields = useMemo(
    () =>
      getSetupSourceControlVisibleFields(providerFields).filter((field) =>
        !isAdo
          ? true
          : adoAuthMode === 'pat'
            ? field.envVarName !== 'ADO_CLIENT_ID' &&
              field.envVarName !== 'ADO_CLIENT_SECRET' &&
              field.envVarName !== 'ADO_TENANT_ID'
            : field.envVarName !== 'ADO_TOKEN',
      ),
    [providerFields, isAdo, adoAuthMode],
  );
  const advancedFields = useMemo(
    () =>
      providerFields.filter(
        (field) => field.advanced === true && field.setupHidden !== true,
      ),
    [providerFields],
  );
  const visibleFields = useMemo(
    () =>
      getSetupSourceControlVisibleFields(providerFields, {
        showAdvancedConfig: isAdo && showAdoAdvancedConfig,
      }).filter((field) =>
        !isAdo
          ? true
          : adoAuthMode === 'pat'
            ? field.envVarName !== 'ADO_CLIENT_ID' &&
              field.envVarName !== 'ADO_CLIENT_SECRET' &&
              field.envVarName !== 'ADO_TENANT_ID'
            : field.envVarName !== 'ADO_TOKEN',
      ),
    [providerFields, isAdo, showAdoAdvancedConfig, adoAuthMode],
  );

  // Key off field content, not array identity — parent refreshes create a new
  // fields array each time and must not wipe in-progress edits.
  const nonSecretInitialValuesKey = providerFields
    .filter((field) => !isSecretSourceControlField(field))
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}:${field.runtimeSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = useMemo(
    () => getNonSecretFieldInitialValues(providerFields),
    // fields array identity is intentionally omitted; content key drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [nonSecretInitialValuesKey],
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => nonSecretInitialValues,
  );

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setShowManualGitHubValues(false);
    setShowAdoAdvancedConfig(false);
    const hasAdoEntraCredentials = providerFields.some(
      (field) =>
        ['ADO_CLIENT_ID', 'ADO_CLIENT_SECRET', 'ADO_TENANT_ID'].includes(
          field.envVarName,
        ) &&
        (field.runtimeSatisfied || field.savedSatisfied),
    );
    const hasAdoPat = providerFields.some(
      (field) =>
        field.envVarName === 'ADO_TOKEN' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    );
    const configuredMode = providerFields.find(
      (field) => field.envVarName === 'ADO_AUTH_MODE',
    )?.savedValue;
    const initialAdoAuthMode =
      configuredMode === 'delegated'
        ? 'delegated'
        : hasAdoEntraCredentials && !hasAdoPat
          ? 'entra'
          : 'pat';
    setAdoAuthMode(initialAdoAuthMode);
    setShowAdoAdvancedConfig(initialAdoAuthMode === 'entra');
    setGithubOrganization('');
    setManifestForm(null);
  }, [effectiveSelectedProviderId, nonSecretInitialValues, providerFields]);

  useEffect(() => {
    if (manifestForm) {
      manifestFormRef.current?.submit();
    }
  }, [manifestForm]);
  const canContinueWithoutNewValues =
    visibleFields.every(
      (field) =>
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied,
    ) ?? false;

  const isActionDisabled =
    saveSourceControlConfig.isPending ||
    !selectedProvider ||
    visibleFields.some((field) => {
      const nextValue = values[field.envVarName]?.trim() ?? '';

      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        nextValue.length === 0
      );
    }) ||
    (isAdo &&
      (adoAuthMode === 'pat'
        ? !(
            values['ADO_TOKEN']?.trim() ||
            providerFields.find((field) => field.envVarName === 'ADO_TOKEN')
              ?.runtimeSatisfied ||
            providerFields.find((field) => field.envVarName === 'ADO_TOKEN')
              ?.savedSatisfied
          )
        : !['ADO_CLIENT_ID', 'ADO_CLIENT_SECRET', 'ADO_TENANT_ID'].every(
            (envVarName) =>
              Boolean(
                values[envVarName]?.trim() ||
                providerFields.find((field) => field.envVarName === envVarName)
                  ?.runtimeSatisfied ||
                providerFields.find((field) => field.envVarName === envVarName)
                  ?.savedSatisfied,
              ),
          )));

  const handleContinue = async () => {
    if (!selectedProvider) {
      return;
    }

    await saveSourceControlConfig.mutateAsync({
      provider: selectedProvider.provider,
      values: {
        ...filterValuesToFields(visibleFields, values),
        ...(isAdo
          ? {
              ADO_AUTH_MODE: adoAuthMode,
              ADO_LINKED_ACCOUNT_ID:
                adoLinkedAccount.data?.account?.accountId ?? '',
            }
          : {}),
      },
    });
  };

  const provider = selectedProvider?.label;
  const providerSetupCopy = selectedProvider
    ? getSourceControlSetupCopy(selectedProvider.provider)
    : null;
  const providerSetupLabel = providerSetupCopy?.setupLabel ?? 'source control';
  const isGitHubManifestDefault =
    selectedProvider?.provider === 'github' && !showManualGitHubValues;
  const isGitLab = selectedProvider?.provider === 'gitlab';
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const gitlabRedirectUri = `${publicOrigin}/api/auth/oauth2/callback/gitlab`;
  const typedGitLabBaseUrl =
    values['GITLAB_BASE_URL']?.trim().replace(/\/+$/, '') ?? '';
  const configuredGitLabBaseUrl =
    sourceControlSetup.gitlabBaseUrl?.trim().replace(/\/+$/, '') ?? '';
  const effectiveGitLabBaseUrl = /^https?:\/\//.test(typedGitLabBaseUrl)
    ? typedGitLabBaseUrl
    : /^https?:\/\//.test(configuredGitLabBaseUrl)
      ? configuredGitLabBaseUrl
      : 'https://gitlab.com';
  const gitlabApplicationsUrl = `${effectiveGitLabBaseUrl}/-/user_settings/applications`;
  const valuesStepNumber = isGitLab ? 3 : 2;

  if (isGitHubManifestDefault) {
    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <StepTitle text="Create GitHub App" />

        <div className="space-y-3 max-w-xl">
          <p>
            Because Roomote is self-hosted, we can&apos;t offer you an
            out-of-the-box GitHub app - you need to create your own.
          </p>
          <p>
            Roomote can create it for you automatically or you can enter values
            manually if you already have an app or want to do each step
            yourself.
          </p>
        </div>

        <div className="space-y-1 max-w-xl mt-6">
          <Label htmlFor="github-app-organization">
            GitHub organization (optional)
          </Label>
          <Input
            id="github-app-organization"
            value={githubOrganization}
            onChange={(event) => setGithubOrganization(event.target.value)}
            placeholder="your-organization"
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
            data-1p-ignore
          />
          <p className="text-sm text-muted-foreground">
            The app can only be installed on the account that owns it. Enter an
            organization name to create the app there, or leave this blank to
            create it on your personal GitHub account.
          </p>
        </div>

        {manifestForm ? (
          <form
            ref={manifestFormRef}
            action={manifestForm.postTarget}
            method="post"
            className="hidden"
            aria-hidden="true"
          >
            <input
              name="manifest"
              value={manifestForm.values.manifest}
              readOnly
            />
          </form>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          {onBack ? (
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={createGitHubAppManifest.isPending}
            >
              <ArrowLeft />
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() =>
              createGitHubAppManifest.mutate({
                redirect: '/setup?step=source-control-connect',
                organization: githubOrganization.trim() || null,
              })
            }
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
          >
            {createGitHubAppManifest.isPending || manifestForm ? (
              <Spinner />
            ) : (
              <Sparkles />
            )}
            Create GitHub App
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowManualGitHubValues(true)}
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
          >
            <Pencil />
            Enter values manually
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
      <StepTitle text={`Configure ${providerSetupLabel}`} />

      <div className="flex gap-2 items-start mt-6">
        <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
          1
        </span>
        <div>
          <p className="font-semibold">
            {providerSetupCopy ? (
              <>
                Create a new {providerSetupCopy.setupLabel}.
                <Button variant="outline" className="ml-2" asChild>
                  <a
                    href={providerSetupCopy.creationHref}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Go <ExternalLink className="inline size-4 -mt-1 ml-1" />
                  </a>
                </Button>
              </>
            ) : (
              <>Create a new {providerSetupLabel}.</>
            )}
          </p>
          {providerSetupCopy?.creationHint ? (
            <p className="text-sm text-muted-foreground">
              {providerSetupCopy.creationHint}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Optionally,{' '}
            <Link
              className="underline underline-offset-4 hover:text-foreground"
              href="/api/setup/roomote-logo"
            >
              download our logo
            </Link>{' '}
            to use as the app or bot account&apos;s avatar so Roomote&apos;s
            activity is easy to recognize.
          </p>
        </div>
      </div>

      {isGitLab ? (
        <div className="flex gap-2 items-start">
          <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
            2
          </span>
          <div>
            <p className="font-semibold">
              Recommended: create a GitLab OAuth application.
              <Button variant="outline" className="ml-2" asChild>
                <a
                  href={gitlabApplicationsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Go <ExternalLink className="inline size-4 -mt-1 ml-1" />
                </a>
              </Button>
            </p>
            <p className="text-sm text-muted-foreground">
              Teammates can trigger Roomote from merge request comments only
              after linking their GitLab account, and that linking flow needs an
              OAuth application. Create one on the bot account (or as a group or
              instance-wide application), mark it confidential, select the{' '}
              <code>read_user</code> scope, and use this redirect URI:
            </p>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <code className="break-all text-foreground">
                {gitlabRedirectUri}
              </code>
              <CopyIconButton
                content={gitlabRedirectUri}
                tooltip="Copy redirect URI"
              />
            </p>
            <p className="text-sm text-muted-foreground">
              Then paste the generated Application ID and Secret into the OAuth
              fields below.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex gap-2 items-start">
        <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
          {valuesStepNumber}
        </span>
        <p className="font-semibold">
          Enter the values below for your {provider ?? 'source control'}{' '}
          integration.
        </p>
      </div>

      {isAdo ? (
        <div className="space-y-2 pl-10">
          <Label>How should Roomote connect?</Label>
          <div className="grid max-w-xl gap-2 sm:grid-cols-3">
            <button
              type="button"
              aria-pressed={adoAuthMode === 'pat'}
              className={`rounded-md border p-3 text-left ${adoAuthMode === 'pat' ? 'border-foreground' : 'border-border'}`}
              onClick={() => {
                setAdoAuthMode('pat');
                setShowAdoAdvancedConfig(false);
              }}
            >
              <span className="block font-medium">Personal access token</span>
              <span className="text-sm text-muted-foreground">
                Fastest setup; use a dedicated bot or service account.
              </span>
            </button>
            <button
              type="button"
              aria-pressed={adoAuthMode === 'entra'}
              className={`rounded-md border p-3 text-left ${adoAuthMode === 'entra' ? 'border-foreground' : 'border-border'}`}
              onClick={() => {
                setAdoAuthMode('entra');
                setShowAdoAdvancedConfig(true);
              }}
            >
              <span className="block font-medium">Microsoft Entra app</span>
              <span className="text-sm text-muted-foreground">
                Short-lived tokens for a service principal.
              </span>
            </button>
            <button
              type="button"
              aria-pressed={adoAuthMode === 'delegated'}
              className={`rounded-md border p-3 text-left ${adoAuthMode === 'delegated' ? 'border-foreground' : 'border-border'}`}
              onClick={() => {
                setAdoAuthMode('delegated');
                setShowAdoAdvancedConfig(true);
              }}
            >
              <span className="block font-medium">Connect with Microsoft</span>
              <span className="text-sm text-muted-foreground">
                Use a delegated Azure DevOps account.
              </span>
            </button>
          </div>
          {adoAuthMode === 'delegated' ? (
            <div className="max-w-xl rounded-md border p-3 text-sm">
              <p className="text-muted-foreground">
                {adoLinkedAccount.data?.account
                  ? `Connected as ${adoLinkedAccount.data.account.displayName}.`
                  : 'Connect the Azure DevOps account Roomote should use.'}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() =>
                  authenticateAdoAccount.mutate(
                    `${window.location.pathname}${window.location.search}`,
                  )
                }
                disabled={authenticateAdoAccount.isPending}
              >
                {authenticateAdoAccount.isPending ? <Spinner /> : null}
                {adoLinkedAccount.data?.account
                  ? 'Reconnect with Microsoft'
                  : 'Connect with Microsoft'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2 pl-10">
        {(isAdo ? baseFields : visibleFields).map((field) => (
          <SourceControlFieldInput
            key={field.envVarName}
            field={field}
            value={values[field.envVarName] ?? ''}
            isEditingSavedValue={Boolean(editingSavedValues[field.envVarName])}
            disabled={saveSourceControlConfig.isPending}
            onChange={(nextValue) =>
              setValues((current) => ({
                ...current,
                [field.envVarName]: nextValue,
              }))
            }
            onStartEditingSavedValue={() =>
              setEditingSavedValues((current) => ({
                ...current,
                [field.envVarName]: true,
              }))
            }
            onStopEditingSavedValue={() =>
              setEditingSavedValues((current) => ({
                ...current,
                [field.envVarName]: false,
              }))
            }
          />
        ))}
        {isAdo && advancedFields.length > 0 ? (
          <div className="pt-1">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
              onClick={() => setShowAdoAdvancedConfig((current) => !current)}
            >
              {showAdoAdvancedConfig
                ? 'Hide advanced config'
                : 'Show advanced config'}
            </button>
          </div>
        ) : null}
        {isAdo && showAdoAdvancedConfig
          ? advancedFields.map((field) => (
              <SourceControlFieldInput
                key={field.envVarName}
                field={field}
                value={values[field.envVarName] ?? ''}
                isEditingSavedValue={Boolean(
                  editingSavedValues[field.envVarName],
                )}
                disabled={saveSourceControlConfig.isPending}
                onChange={(nextValue) =>
                  setValues((current) => ({
                    ...current,
                    [field.envVarName]: nextValue,
                  }))
                }
                onStartEditingSavedValue={() =>
                  setEditingSavedValues((current) => ({
                    ...current,
                    [field.envVarName]: true,
                  }))
                }
                onStopEditingSavedValue={() =>
                  setEditingSavedValues((current) => ({
                    ...current,
                    [field.envVarName]: false,
                  }))
                }
              />
            ))
          : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
        {onBack ? (
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={saveSourceControlConfig.isPending}
          >
            <ArrowLeft />
            Back
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={isActionDisabled}
        >
          {saveSourceControlConfig.isPending
            ? 'Saving...'
            : canContinueWithoutNewValues
              ? isAdo &&
                adoAuthMode === 'delegated' &&
                !adoLinkedAccount.data?.account
                ? 'Save and connect with Microsoft'
                : 'Continue'
              : 'Save and continue'}
          {saveSourceControlConfig.isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </div>
    </div>
  );
}

function SourceControlFieldInput({
  field,
  value,
  isEditingSavedValue,
  disabled,
  onChange,
  onStartEditingSavedValue,
  onStopEditingSavedValue,
}: {
  field: SourceControlField;
  value: string;
  isEditingSavedValue: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onStartEditingSavedValue: () => void;
  onStopEditingSavedValue: () => void;
}) {
  const isSecretField = isSecretSourceControlField(field);
  const shouldShowSavedValueMask =
    isSecretField &&
    !field.runtimeSatisfied &&
    field.savedSatisfied &&
    value.length === 0 &&
    !isEditingSavedValue;

  return (
    <div className="grid gap-2 md:grid-cols-[200px_minmax(0,1fr)] md:items-center max-w-xl">
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
            type={isSecretField ? undefined : 'text'}
            className="font-mono"
            value={
              isSecretField && field.runtimeSatisfied
                ? MASKED_VALUE
                : shouldShowSavedValueMask
                  ? MASKED_VALUE
                  : field.runtimeSatisfied && !isSecretField
                    ? (field.savedValue ?? value)
                    : value
            }
            onFocus={() => {
              if (shouldShowSavedValueMask) {
                onStartEditingSavedValue();
              }
            }}
            onBlur={() => {
              if (isSecretField && field.savedSatisfied && value.length === 0) {
                onStopEditingSavedValue();
              }
            }}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.runtimeSatisfied ? '' : field.envVarName}
            disabled={disabled || field.runtimeSatisfied}
            data-1p-ignore
          />
          {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
        </div>
      </div>
    </div>
  );
}

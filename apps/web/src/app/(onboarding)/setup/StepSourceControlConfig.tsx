'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getSetupSourceControlVisibleFields,
  type SetupSourceControlStatus,
  type SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Button,
  Check,
  ExternalLink,
  Input,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { NumberedStep } from './NumberedStep';
import {
  AdoSourceControlConfig,
  AdoSourceControlInstructions,
  DEFAULT_ADO_AUTH_MODE,
} from './AdoSourceControlConfig';
import { GitHubSourceControlConfig } from './GitHubSourceControlConfig';
import { GiteaSourceControlInstructions } from './GiteaSourceControlConfig';
import { GitLabSourceControlInstructions } from './GitLabSourceControlConfig';
import {
  BitbucketSourceControlCreation,
  BitbucketSourceControlInstructions,
} from './BitbucketSourceControlConfig';
import { getSourceControlSetupCopy } from './sourceControlSetupCopy';

const MASKED_VALUE = '••••••••••••••••••••••••••••';
const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';
const DEFAULT_GITEA_BASE_URL = 'https://gitea.com';

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
    } else if (field.envVarName === 'GITLAB_BASE_URL') {
      next[field.envVarName] = DEFAULT_GITLAB_BASE_URL;
    } else if (field.envVarName === 'GITEA_BASE_URL') {
      next[field.envVarName] = DEFAULT_GITEA_BASE_URL;
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

function normalizeGitLabSetupUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'https://gitlab.com';
  }

  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (url.hostname === 'gitlab.com') {
      url.pathname = '/';
    } else if (/\/api\/v4$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/api\/v4$/, '') || '/';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return 'https://gitlab.com';
  }
}

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
  const [showGitlabAdvancedConfig, setShowGitlabAdvancedConfig] =
    useState(false);
  const [showGiteaAdvancedConfig, setShowGiteaAdvancedConfig] = useState(false);
  const [adoAuthMode, setAdoAuthMode] = useState<'pat' | 'entra' | 'delegated'>(
    DEFAULT_ADO_AUTH_MODE,
  );
  const saveSourceControlConfig = useMutation(
    trpc.setupNew.saveSourceControlConfig.mutationOptions({
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
        showAdvancedConfig:
          (isAdo && showAdoAdvancedConfig) ||
          (selectedProvider?.provider === 'gitlab' &&
            showGitlabAdvancedConfig) ||
          (selectedProvider?.provider === 'gitea' && showGiteaAdvancedConfig),
      }).filter((field) =>
        !isAdo
          ? true
          : adoAuthMode === 'pat'
            ? field.envVarName !== 'ADO_CLIENT_ID' &&
              field.envVarName !== 'ADO_CLIENT_SECRET' &&
              field.envVarName !== 'ADO_TENANT_ID'
            : field.envVarName !== 'ADO_TOKEN',
      ),
    [
      providerFields,
      isAdo,
      showAdoAdvancedConfig,
      showGitlabAdvancedConfig,
      showGiteaAdvancedConfig,
      adoAuthMode,
      selectedProvider?.provider,
    ],
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
    setShowGitlabAdvancedConfig(false);
    setShowGiteaAdvancedConfig(false);
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
    const configuredMode = providerFields
      .find((field) => field.envVarName === 'ADO_AUTH_MODE')
      ?.savedValue?.trim();
    const initialAdoAuthMode =
      configuredMode === 'pat'
        ? 'pat'
        : configuredMode === 'entra'
          ? 'entra'
          : configuredMode === 'delegated'
            ? 'delegated'
            : hasAdoEntraCredentials && !hasAdoPat
              ? 'entra'
              : hasAdoPat
                ? 'pat'
                : DEFAULT_ADO_AUTH_MODE;
    setAdoAuthMode(initialAdoAuthMode);
    setShowAdoAdvancedConfig(false);
  }, [effectiveSelectedProviderId, nonSecretInitialValues, providerFields]);
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
              ADO_LINKED_ACCOUNT_ID: '',
            }
          : {}),
      },
    });

    if (
      selectedProvider.provider === 'gitea' ||
      selectedProvider.provider === 'gitlab' ||
      selectedProvider.provider === 'bitbucket'
    ) {
      window.location.assign(
        `/api/source-control/${selectedProvider.provider}/oauth/authorize`,
      );
    }
  };

  const provider = selectedProvider?.label;
  const providerSetupCopy = selectedProvider
    ? getSourceControlSetupCopy(selectedProvider.provider)
    : null;
  const providerSetupLabel = providerSetupCopy?.setupLabel ?? 'source control';
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const rawGitLabBaseUrl =
    values['GITLAB_BASE_URL']?.trim() ||
    sourceControlSetup.gitlabBaseUrl?.trim() ||
    '';
  const creationHref =
    selectedProvider?.provider === 'gitlab'
      ? rawGitLabBaseUrl
        ? `${normalizeGitLabSetupUrl(rawGitLabBaseUrl)}/-/user_settings/applications`
        : undefined
      : providerSetupCopy?.creationHref;

  if (selectedProvider?.provider === 'github' && !showManualGitHubValues) {
    const managedGitHubConnectionUrl =
      sourceControlSetup.managedGitHubConnectionUrl?.trim() || null;

    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <StepTitle
          text={
            managedGitHubConnectionUrl ? 'Connect GitHub' : 'Create GitHub App'
          }
        />
        <GitHubSourceControlConfig
          onBack={onBack}
          onManualValues={() => setShowManualGitHubValues(true)}
          managedConnectionUrl={managedGitHubConnectionUrl}
          onManagedContinue={onContinue}
        />
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
      <StepTitle text={`Configure ${providerSetupLabel}`} />

      {!isAdo ? (
        <NumberedStep number={1} className="mt-6">
          {selectedProvider?.provider === 'bitbucket' ? (
            <BitbucketSourceControlCreation />
          ) : (
            <>
              <p className="font-semibold">
                {providerSetupCopy ? (
                  <>
                    Create a new {providerSetupCopy.setupLabel}.
                    {creationHref && (
                      <Button variant="outline" className="ml-2" asChild>
                        <a
                          href={creationHref ?? providerSetupCopy.creationHref}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {providerSetupCopy.creationLinkLabel ?? 'Open'}{' '}
                          <ExternalLink className="inline size-4 -mt-1 ml-1" />
                        </a>
                      </Button>
                    )}
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
            </>
          )}
        </NumberedStep>
      ) : (
        <NumberedStep number={1} className="mt-6">
          <AdoSourceControlConfig
            authMode={adoAuthMode}
            onAuthModeChange={(mode) => {
              setAdoAuthMode(mode);
              setShowAdoAdvancedConfig(false);
            }}
          />
        </NumberedStep>
      )}

      {isAdo ||
      selectedProvider?.provider === 'gitea' ||
      selectedProvider?.provider === 'gitlab' ||
      selectedProvider?.provider === 'bitbucket' ? (
        <NumberedStep number={2}>
          {isAdo ? (
            <AdoSourceControlInstructions
              authMode={adoAuthMode}
              publicOrigin={publicOrigin}
            />
          ) : selectedProvider?.provider === 'gitea' ? (
            <GiteaSourceControlInstructions publicOrigin={publicOrigin} />
          ) : selectedProvider?.provider === 'gitlab' ? (
            <GitLabSourceControlInstructions publicOrigin={publicOrigin} />
          ) : (
            <BitbucketSourceControlInstructions publicOrigin={publicOrigin} />
          )}
        </NumberedStep>
      ) : null}

      <NumberedStep
        number={
          isAdo ||
          selectedProvider?.provider === 'gitea' ||
          selectedProvider?.provider === 'gitlab' ||
          selectedProvider?.provider === 'bitbucket'
            ? 3
            : 2
        }
      >
        {selectedProvider?.provider === 'bitbucket' ? (
          <>
            <p className="font-semibold">
              Enter the values below for your Bitbucket integration.
            </p>
            <p className="text-sm text-muted-foreground">
              Once created,, copy these values:
            </p>
          </>
        ) : (
          <p className="font-semibold">
            Enter the values below for your {provider ?? 'source control'}{' '}
            integration.
          </p>
        )}

        <div className="space-y-2">
          {isAdo && adoAuthMode === 'delegated' && (
            <p className="text-sm text-muted-foreground">
              Create a client secret, grant the Azure DevOps delegated
              permissions required by your organization, and grant admin consent
              if your tenant requires it.
            </p>
          )}
          {isAdo && adoAuthMode === 'entra' && (
            <p className="text-sm text-muted-foreground">
              Create a client secret, add the application to the Azure DevOps
              organization, and grant it access to the projects and repositories
              Roomote should use.
            </p>
          )}

          {(isAdo ? baseFields : visibleFields).map((field) => (
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
          ))}
          {(isAdo ||
            selectedProvider?.provider === 'gitlab' ||
            selectedProvider?.provider === 'gitea') &&
          advancedFields.length > 0 ? (
            <div className="pt-1">
              <button
                type="button"
                className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
                onClick={() =>
                  isAdo
                    ? setShowAdoAdvancedConfig((current) => !current)
                    : selectedProvider?.provider === 'gitlab'
                      ? setShowGitlabAdvancedConfig((current) => !current)
                      : setShowGiteaAdvancedConfig((current) => !current)
                }
              >
                {(
                  isAdo
                    ? showAdoAdvancedConfig
                    : selectedProvider?.provider === 'gitlab'
                      ? showGitlabAdvancedConfig
                      : showGiteaAdvancedConfig
                )
                  ? 'Hide advanced config'
                  : 'Show advanced config'}
              </button>
            </div>
          ) : null}
          {(isAdo
            ? showAdoAdvancedConfig
            : selectedProvider?.provider === 'gitlab'
              ? showGitlabAdvancedConfig
              : showGiteaAdvancedConfig) && advancedFields.length > 0
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
      </NumberedStep>

      <SetupFooter
        onBack={onBack}
        backDisabled={saveSourceControlConfig.isPending}
        className="mt-8"
      >
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={isActionDisabled}
        >
          {saveSourceControlConfig.isPending
            ? 'Saving...'
            : canContinueWithoutNewValues
              ? 'Continue'
              : 'Save and continue'}
          {saveSourceControlConfig.isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </SetupFooter>
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
          {field.required && '*'}
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

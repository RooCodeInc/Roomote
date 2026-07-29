'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT,
  type SetupSourceControlStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { Button, Check, Input, Spinner } from '@/components/system';
import {
  useAdoLinkedAccount,
  useAuthenticateAdoAccount,
} from '@/hooks/linked-accounts';

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

/** Drop secret entries so plaintext does not linger after a successful save. */
function withoutSecretFieldValues(
  fields: readonly SourceControlField[],
  current: Record<string, string>,
): Record<string, string> {
  const next = { ...current };

  for (const field of fields) {
    if (isSecretSourceControlField(field)) {
      delete next[field.envVarName];
    }
  }

  return next;
}

export function SourceControlConfigForm({
  provider,
  configStatus,
  onSaved,
  saveSuccessMessage,
}: {
  provider: SetupSourceControlStatus['preselectedProvider'];
  configStatus: SetupSourceControlStatus | undefined;
  onSaved?: () => void;
  saveSuccessMessage?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const providerStatus = useMemo(
    () =>
      configStatus?.providers.find(
        (candidate) => candidate.provider === provider,
      ),
    [configStatus, provider],
  );

  // Key off field content, not array identity — query/refetch creates a new
  // fields array each time and must not wipe in-progress edits.
  const nonSecretInitialValuesKey = (providerStatus?.fields ?? [])
    .filter((field) => !isSecretSourceControlField(field))
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}:${field.runtimeSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = useMemo(
    () => getNonSecretFieldInitialValues(providerStatus?.fields ?? []),
    // fields array identity is intentionally omitted; content key drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [nonSecretInitialValuesKey],
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => nonSecretInitialValues,
  );
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [adoAuthMode, setAdoAuthMode] = useState<'pat' | 'entra' | 'delegated'>(
    'pat',
  );
  const adoLinkedAccount = useAdoLinkedAccount();
  const authenticateAdoAccount = useAuthenticateAdoAccount();

  const isAdo = provider === 'ado';
  const fieldsForAuthMode = (fields: readonly SourceControlField[]) =>
    fields.filter(
      (field) =>
        field.settingsHidden !== true &&
        (!isAdo
          ? true
          : adoAuthMode === 'pat'
            ? field.envVarName !== 'ADO_CLIENT_ID' &&
              field.envVarName !== 'ADO_CLIENT_SECRET' &&
              field.envVarName !== 'ADO_TENANT_ID'
            : field.envVarName !== 'ADO_TOKEN'),
    );
  const visibleFields = fieldsForAuthMode(providerStatus?.fields ?? []);

  const saveConfig = useMutation(
    trpc.sourceControl.saveConfig.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.sourceControl.configStatus.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.sourceControl.repositories.queryKey(),
        });
        // Secret-only saves leave non-secret content keys unchanged, so the
        // content-keyed reset effect will not run — clear secrets explicitly.
        setValues((current) =>
          withoutSecretFieldValues(visibleFields, current),
        );
        setEditingSavedValues({});
        toast.success(
          saveSuccessMessage ?? 'Source-control configuration saved.',
        );
        onSaved?.();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    if (isAdo) {
      const configuredMode = providerStatus?.fields.find(
        (field) => field.envVarName === 'ADO_AUTH_MODE',
      )?.savedValue;
      const hasPat = providerStatus?.fields.some(
        (field) => field.envVarName === 'ADO_TOKEN' && field.savedSatisfied,
      );
      const hasEntra = [
        'ADO_CLIENT_ID',
        'ADO_CLIENT_SECRET',
        'ADO_TENANT_ID',
      ].every((envVarName) =>
        providerStatus?.fields.some(
          (field) => field.envVarName === envVarName && field.savedSatisfied,
        ),
      );
      setAdoAuthMode(
        configuredMode === 'delegated'
          ? 'delegated'
          : hasEntra && !hasPat
            ? 'entra'
            : 'pat',
      );
    }
    // providerStatus.fields array identity is intentionally omitted; content
    // key and derived non-secret values drive resets instead of query refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
  }, [provider, nonSecretInitialValues, isAdo, nonSecretInitialValuesKey]);

  if (!providerStatus) {
    return null;
  }

  const hasAdoAppCredentials = [
    'ADO_CLIENT_ID',
    'ADO_CLIENT_SECRET',
    'ADO_TENANT_ID',
  ].every((envVarName) =>
    Boolean(
      values[envVarName]?.trim() ||
      providerStatus.fields.find((field) => field.envVarName === envVarName)
        ?.runtimeSatisfied ||
      providerStatus.fields.find((field) => field.envVarName === envVarName)
        ?.savedSatisfied,
    ),
  );
  const hasAdoPat = Boolean(
    values['ADO_TOKEN']?.trim() ||
    providerStatus.fields.find((field) => field.envVarName === 'ADO_TOKEN')
      ?.runtimeSatisfied ||
    providerStatus.fields.find((field) => field.envVarName === 'ADO_TOKEN')
      ?.savedSatisfied,
  );

  const isActionDisabled =
    saveConfig.isPending ||
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
        ? !hasAdoPat
        : !hasAdoAppCredentials ||
          (adoAuthMode === 'delegated' && !adoLinkedAccount.data?.account)));

  const hasNewValues = visibleFields.some((field) => {
    if (field.runtimeSatisfied) {
      return false;
    }
    const nextValue = values[field.envVarName]?.trim() ?? '';
    if (!isSecretSourceControlField(field)) {
      return nextValue !== (field.savedValue?.trim() ?? '');
    }
    return nextValue.length > 0;
  });

  return (
    <div className="space-y-4">
      {isAdo ? (
        <div className="grid max-w-xl gap-2 sm:grid-cols-3">
          <button
            type="button"
            aria-pressed={adoAuthMode === 'pat'}
            className={`rounded-md border p-3 text-left ${adoAuthMode === 'pat' ? 'border-foreground' : 'border-border'}`}
            onClick={() => setAdoAuthMode('pat')}
          >
            <span className="block font-medium">Personal access token</span>
            <span className="text-sm text-muted-foreground">
              Use a PAT from a bot or service account.
            </span>
          </button>
          <button
            type="button"
            aria-pressed={adoAuthMode === 'entra'}
            className={`rounded-md border p-3 text-left ${adoAuthMode === 'entra' ? 'border-foreground' : 'border-border'}`}
            onClick={() => setAdoAuthMode('entra')}
          >
            <span className="block font-medium">
              Microsoft Entra service principal
            </span>
            <span className="text-sm text-muted-foreground">
              Use short-lived service-principal tokens.
            </span>
          </button>
          <button
            type="button"
            aria-pressed={adoAuthMode === 'delegated'}
            className={`rounded-md border p-3 text-left ${adoAuthMode === 'delegated' ? 'border-foreground' : 'border-border'}`}
            onClick={() => setAdoAuthMode('delegated')}
          >
            <span className="block font-medium">
              Connect with your Microsoft account
            </span>
            <span className="text-sm text-muted-foreground">
              Use a delegated Azure DevOps account.
            </span>
          </button>
        </div>
      ) : null}
      {isAdo && adoAuthMode !== 'pat' ? (
        <p className="max-w-xl text-sm text-muted-foreground">
          The Microsoft Entra app registration needs the{' '}
          <span className="font-medium text-foreground">
            {ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT}
          </span>{' '}
          API permissions, saved and admin-consented.{' '}
          <a
            href="https://docs.roomote.dev/providers/source-control/azure-devops#required-api-permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline"
          >
            Setup guide
          </a>
        </p>
      ) : null}
      {isAdo && adoAuthMode === 'delegated' ? (
        <div className="max-w-xl rounded-md border p-3 text-sm">
          <p className="text-muted-foreground">
            {adoLinkedAccount.data?.account
              ? `Connected as ${adoLinkedAccount.data.account.displayName}.`
              : 'Connect the Azure DevOps account Roomote should use for this deployment.'}
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
            disabled={
              authenticateAdoAccount.isPending ||
              adoLinkedAccount.data?.configured !== true
            }
          >
            {authenticateAdoAccount.isPending ? <Spinner /> : null}
            {adoLinkedAccount.data?.account
              ? 'Reconnect with Microsoft'
              : adoLinkedAccount.data?.configured === true
                ? 'Connect with your Microsoft account'
                : 'Save app settings first'}
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        {visibleFields.map((field) => {
          const value = values[field.envVarName] ?? '';
          const isSecretField = isSecretSourceControlField(field);
          const shouldShowSavedValueMask =
            isSecretField &&
            !field.runtimeSatisfied &&
            field.savedSatisfied &&
            value.length === 0 &&
            !editingSavedValues[field.envVarName];

          return (
            <div
              key={field.envVarName}
              className="grid max-w-xl gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center"
            >
              <div className="text-sm font-medium">
                {field.label}
                {field.required === false ? ' (optional)' : ''}
              </div>
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
                      setEditingSavedValues((current) => ({
                        ...current,
                        [field.envVarName]: true,
                      }));
                    }
                  }}
                  onBlur={() => {
                    if (
                      isSecretField &&
                      field.savedSatisfied &&
                      value.length === 0
                    ) {
                      setEditingSavedValues((current) => ({
                        ...current,
                        [field.envVarName]: false,
                      }));
                    }
                  }}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.envVarName]: event.target.value,
                    }))
                  }
                  placeholder={field.runtimeSatisfied ? '' : field.envVarName}
                  disabled={saveConfig.isPending || field.runtimeSatisfied}
                  data-1p-ignore
                />
                {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            saveConfig.mutate({
              provider,
              values: {
                ...Object.fromEntries(
                  visibleFields.flatMap((field) => {
                    const value = values[field.envVarName] ?? '';
                    if (
                      isSecretSourceControlField(field) &&
                      field.savedSatisfied &&
                      value.length === 0
                    ) {
                      return [];
                    }
                    return [[field.envVarName, value]];
                  }),
                ),
                ...(isAdo
                  ? {
                      ADO_AUTH_MODE: adoAuthMode,
                      ADO_LINKED_ACCOUNT_ID:
                        adoLinkedAccount.data?.account?.accountId ?? '',
                    }
                  : {}),
              },
            })
          }
          disabled={isActionDisabled}
        >
          {saveConfig.isPending ? <Spinner /> : null}
          {hasNewValues ? 'Save configuration' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

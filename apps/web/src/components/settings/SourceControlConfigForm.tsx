'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SetupSourceControlStatus } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  AdoSourceControlConfigFields,
  getAdoOAuthValidationError,
  getEffectiveAdoBaseUrl,
  getEffectiveAdoOrganization,
} from '@/components/source-control/AdoSourceControlConfigFields';
import { Button, Check, Input, Spinner } from '@/components/system';
import {
  getAdoBaseUrlValidationError,
  getAdoOrganizationValidationError,
} from '@/lib/ado';
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
  const [adoOrganizationConfirmed, setAdoOrganizationConfirmed] =
    useState(false);
  const [adoAdvancedExpanded, setAdoAdvancedExpanded] = useState(false);
  const [adoOauthExpanded, setAdoOauthExpanded] = useState(false);
  const adoPostSaveActionRef = useRef<'save' | 'link'>('save');
  const adoLinkedAccount = useAdoLinkedAccount({ enabled: provider === 'ado' });
  const authenticateAdoAccount = useAuthenticateAdoAccount();
  const hasConfiguredAdoOrganization =
    provider === 'ado' &&
    providerStatus?.fields.some(
      (field) =>
        field.envVarName === 'ADO_ORGANIZATION' &&
        (field.runtimeSatisfied || field.savedSatisfied),
    ) === true;

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
          withoutSecretFieldValues(providerStatus?.fields ?? [], current),
        );
        setEditingSavedValues({});
        setAdoAdvancedExpanded(false);
        setAdoOauthExpanded(false);
        toast.success(
          saveSuccessMessage ?? 'Source-control configuration saved.',
        );
        onSaved?.();
        if (adoPostSaveActionRef.current === 'link') {
          adoPostSaveActionRef.current = 'save';
          authenticateAdoAccount.mutate('/settings?service=ado');
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setAdoOrganizationConfirmed(hasConfiguredAdoOrganization);
    setAdoAdvancedExpanded(false);
    setAdoOauthExpanded(false);
  }, [hasConfiguredAdoOrganization, provider, nonSecretInitialValues]);

  if (!providerStatus) {
    return null;
  }

  const isSaveActionDisabled =
    saveConfig.isPending ||
    providerStatus.fields.some((field) => {
      const nextValue = values[field.envVarName]?.trim() ?? '';
      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        nextValue.length === 0
      );
    });
  const isAdo = provider === 'ado';
  const adoOrganization = isAdo
    ? getEffectiveAdoOrganization(providerStatus.fields, values)
    : '';
  const adoBaseUrl = isAdo
    ? getEffectiveAdoBaseUrl(providerStatus.fields, values)
    : '';
  const adoOrganizationValidationError = getAdoOrganizationValidationError(
    adoOrganization,
    adoBaseUrl,
  );
  const adoBaseUrlValidationError = getAdoBaseUrlValidationError(adoBaseUrl);
  const adoOAuthValidationError = isAdo
    ? getAdoOAuthValidationError(providerStatus.fields, values)
    : null;
  const canConfirmAdoOrganization =
    adoOrganizationValidationError === null &&
    adoBaseUrlValidationError === null;
  const isActionDisabled =
    isAdo && !adoOrganizationConfirmed
      ? saveConfig.isPending || !canConfirmAdoOrganization
      : isSaveActionDisabled ||
        (isAdo &&
          (adoOrganizationValidationError !== null ||
            adoBaseUrlValidationError !== null));
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const adoRedirectUri = `${publicOrigin}/api/auth/oauth2/callback/ado`;

  const hasNewValues = providerStatus.fields.some((field) => {
    if (field.runtimeSatisfied) {
      return false;
    }
    const nextValue = values[field.envVarName]?.trim() ?? '';
    if (!isSecretSourceControlField(field)) {
      return nextValue !== (field.savedValue?.trim() ?? '');
    }
    return nextValue.length > 0;
  });

  const handleAction = () => {
    if (isAdo && !adoOrganizationConfirmed) {
      if (!canConfirmAdoOrganization) {
        return;
      }

      const organizationField = providerStatus.fields.find(
        (field) => field.envVarName === 'ADO_ORGANIZATION',
      );

      if (!organizationField?.runtimeSatisfied) {
        setValues((current) => ({
          ...current,
          ADO_ORGANIZATION: adoOrganization,
        }));
      }
      setAdoAdvancedExpanded(false);
      setAdoOrganizationConfirmed(true);
      return;
    }

    saveConfig.mutate({ provider, values });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {isAdo ? (
          <AdoSourceControlConfigFields
            fields={providerStatus.fields}
            values={values}
            editingSavedValues={editingSavedValues}
            organizationConfirmed={adoOrganizationConfirmed}
            advancedExpanded={adoAdvancedExpanded}
            oauthExpanded={adoOauthExpanded}
            oauthCallbackUrl={adoRedirectUri}
            oauthAccountLinked={Boolean(adoLinkedAccount.data?.account)}
            oauthAccountStatePending={adoLinkedAccount.isPending}
            oauthLinkPending={authenticateAdoAccount.isPending}
            disabled={saveConfig.isPending || authenticateAdoAccount.isPending}
            compact
            idPrefix="settings-ado"
            onValueChange={(envVarName, value) =>
              setValues((current) => ({
                ...current,
                [envVarName]: value,
              }))
            }
            onEditingSavedValueChange={(envVarName, editing) =>
              setEditingSavedValues((current) => ({
                ...current,
                [envVarName]: editing,
              }))
            }
            onEditOrganization={() => {
              setAdoAdvancedExpanded(false);
              setAdoOrganizationConfirmed(false);
            }}
            onAdvancedExpandedChange={setAdoAdvancedExpanded}
            onOauthExpandedChange={setAdoOauthExpanded}
            onLinkAccount={() =>
              authenticateAdoAccount.mutate('/settings?service=ado')
            }
            onSaveAndLinkAccount={() => {
              adoPostSaveActionRef.current = 'link';
              saveConfig.mutate({ provider, values });
            }}
          />
        ) : (
          providerStatus.fields.map((field) => {
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
                  {(field.runtimeSatisfied || field.savedSatisfied) && (
                    <Check />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            adoPostSaveActionRef.current = 'save';
            handleAction();
          }}
          disabled={
            isActionDisabled ||
            authenticateAdoAccount.isPending ||
            adoOAuthValidationError !== null
          }
        >
          {saveConfig.isPending ? <Spinner /> : null}
          {isAdo && !adoOrganizationConfirmed
            ? 'Continue'
            : hasNewValues
              ? 'Save configuration'
              : 'Save'}
        </Button>
      </div>
    </div>
  );
}

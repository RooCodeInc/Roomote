'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  isComputeCredentialField,
  isComputeInfrastructureField,
  type ComputeProvider,
  type SetupComputeStatus,
  type SetupNewComputeProvisioningState,
} from '@roomote/types';

import { getComputeCredentialsHint } from '@/app/(onboarding)/setup/computeSetupCopy';
import {
  Badge,
  BrandIcon,
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EnvVarsInfoNote,
  Input,
  Spinner,
  Trash2,
} from '@/components/system';
import { Section } from './Section';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

const BRAND_ICON_BY_PROVIDER: Record<ComputeProvider, string> = {
  modal: 'modal',
  docker: 'docker',
  daytona: 'daytona',
  e2b: 'e2b',
};

type ComputeProviderStatus = SetupComputeStatus['providers'][number];

function isSecretComputeField(
  field: Pick<ComputeProviderStatus['fields'][number], 'secret'>,
) {
  return field.secret === true;
}

function getNonSecretFieldInitialValues(
  fields: ComputeProviderStatus['fields'],
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const field of fields) {
    if (isSecretComputeField(field) || field.runtimeSatisfied) {
      continue;
    }

    const savedValue = field.savedValue?.trim();
    if (savedValue) {
      next[field.envVarName] = savedValue;
    }
  }

  return next;
}

function ComputeProviderIcon({ provider }: { provider: ComputeProvider }) {
  const brandIconId = BRAND_ICON_BY_PROVIDER[provider];

  return <BrandIcon icon={brandIconId} name="" className="size-4 shrink-0" />;
}

function getAdvancedInfrastructureDescription({
  provider,
  hasMissingDefaultBlockingInfra,
}: {
  provider: ComputeProviderStatus;
  hasMissingDefaultBlockingInfra: boolean;
}) {
  if (hasMissingDefaultBlockingInfra) {
    return `${provider.label} needs this provider artifact unless the shared worker image above is registry-qualified and can be used automatically.`;
  }

  return 'Optional overrides. Leave blank to derive or provision these automatically from the shared worker image.';
}

function getCreateAccountHeading(provider: ComputeProviderStatus) {
  const article = provider.label === 'E2B' ? 'an' : 'a';

  return `Create ${article} ${provider.label} account`;
}

type ComputeProviderSectionProps = {
  provider: ComputeProviderStatus;
  isDefault: boolean;
  /** Worker base-image provisioning progress (provisionable providers only). */
  provisioning?: SetupNewComputeProvisioningState | null;
  onSave: (provider: ComputeProvider, values: Record<string, string>) => void;
  onClear: (provider: ComputeProvider) => void;
  savePending: boolean;
  clearPending: boolean;
};

export function ComputeProviderSection({
  provider,
  isDefault,
  provisioning = null,
  onSave,
  onClear,
  savePending,
  clearPending,
}: ComputeProviderSectionProps) {
  const inputFields = provider.fields.filter(isComputeCredentialField);
  // Provider-specific infrastructure values (base image ref, template id,
  // snapshot name, domain/region) offered as advanced overrides. Runtime-env
  // values are locked and hidden from the editable list.
  const advancedInfraFields = provider.fields.filter(
    (field) => isComputeInfrastructureField(field) && !field.runtimeSatisfied,
  );
  const missingDefaultBlockingInfraFields = advancedInfraFields.filter(
    (field) =>
      field.required !== false &&
      !field.savedSatisfied &&
      !field.defaultSatisfied &&
      !field.setupProvisionable,
  );
  const hasMissingDefaultBlockingInfra =
    missingDefaultBlockingInfraFields.length > 0;
  const hasNoInputFields = inputFields.length === 0;
  const hasConfiguredValues = inputFields.some(
    (field) => field.runtimeSatisfied || field.savedSatisfied,
  );
  const hasSavedValues = provider.fields.some((field) => field.savedSatisfied);

  const [expanded, setExpanded] = useState(
    () => hasNoInputFields || hasConfiguredValues,
  );
  // Key off field content, not array identity — query/refetch creates a new
  // fields array each time and must not wipe in-progress edits (including
  // clearing a saved optional non-secret value, which enables Save).
  const nonSecretInitialValuesKey = provider.fields
    .filter((field) => !isSecretComputeField(field))
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}:${field.runtimeSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = useMemo(
    () => getNonSecretFieldInitialValues(provider.fields),
    // provider.fields is intentionally omitted; content key drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [nonSecretInitialValuesKey],
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => nonSecretInitialValues,
  );
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setRemoveDialogOpen(false);
    setExpanded(hasNoInputFields || hasConfiguredValues);
  }, [
    provider.provider,
    nonSecretInitialValues,
    hasNoInputFields,
    hasConfiguredValues,
    hasSavedValues,
  ]);

  const credentialsHint = getComputeCredentialsHint(provider.provider);

  // Env-only fields the deployment provisions itself once credentials are
  // saved (the E2B worker template build, the Daytona snapshot registration).
  const provisionableEnvOnlyFields = provider.fields.filter(
    (field) =>
      isComputeInfrastructureField(field) &&
      field.setupProvisionable &&
      !field.runtimeSatisfied &&
      !field.savedSatisfied,
  );
  const provisioningRunning = provisioning?.status === 'building';
  // Provisionable artifact fields (E2B_TEMPLATE_ID / DAYTONA_SNAPSHOT_NAME)
  // are editable advanced overrides that also auto-provision when left blank,
  // so their status is rendered inline with the advanced input rather than as
  // a separate row.
  const isProvisionableArtifactField = (
    field: ComputeProviderStatus['fields'][number],
  ) =>
    isComputeInfrastructureField(field) &&
    field.setupProvisionable &&
    !field.runtimeSatisfied &&
    !field.savedSatisfied;
  // A failed run is retried by saving again — even with no new values, as
  // long as the required credentials are already satisfied.
  const canRetryProvisioning =
    provisioning?.status === 'failed' &&
    provisionableEnvOnlyFields.length > 0 &&
    inputFields.every((field) => {
      const nextValue = values[field.envVarName]?.trim() ?? '';
      return (
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied ||
        nextValue.length > 0
      );
    });

  const hasPendingValueChanges = [...inputFields, ...advancedInfraFields].some(
    (field) => {
      if (field.runtimeSatisfied) {
        return false;
      }

      const nextValue = values[field.envVarName]?.trim() ?? '';

      // Non-secret fields are prefilled from savedValue, so both edits and
      // clears of a previously saved value count as pending changes.
      if (!isSecretComputeField(field)) {
        return nextValue !== (field.savedValue?.trim() ?? '');
      }

      // Secrets are never prefilled; any non-empty entry is a pending update.
      return nextValue.length > 0;
    },
  );

  const hasMissingRequiredValue = inputFields.some((field) => {
    const nextValue = values[field.envVarName]?.trim() ?? '';
    return (
      field.required !== false &&
      !field.runtimeSatisfied &&
      !field.savedSatisfied &&
      nextValue.length === 0
    );
  });

  const isActionDisabled =
    provisioningRunning ||
    hasMissingRequiredValue ||
    (!hasPendingValueChanges && !canRetryProvisioning);

  const hasEditableFields =
    inputFields.some((field) => !field.runtimeSatisfied) ||
    advancedInfraFields.length > 0;
  const runtimeConfigured =
    inputFields.length > 0 &&
    inputFields.every((field) => field.runtimeSatisfied);

  const handleSave = () => {
    onSave(provider.provider, values);
  };

  const handleRemove = () => {
    onClear(provider.provider);
  };

  const renderFieldInput = (field: ComputeProviderStatus['fields'][number]) => {
    const value = values[field.envVarName] ?? '';
    const isSecretField = isSecretComputeField(field);
    const shouldShowSavedValueMask =
      isSecretField &&
      !field.runtimeSatisfied &&
      field.savedSatisfied &&
      value.length === 0 &&
      !editingSavedValues[field.envVarName];

    return (
      <div
        key={field.envVarName}
        className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center max-w-xl"
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
              if (isSecretField && field.savedSatisfied && value.length === 0) {
                setEditingSavedValues((current) => ({
                  ...current,
                  [field.envVarName]: false,
                }));
              }
            }}
            onChange={(event) => {
              const nextValue = event.target.value;
              setValues((current) => ({
                ...current,
                [field.envVarName]: nextValue,
              }));
            }}
            placeholder={field.runtimeSatisfied ? '' : field.label}
            disabled={savePending || field.runtimeSatisfied}
            data-1p-ignore
          />
          {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
        </div>
      </div>
    );
  };

  return (
    <>
      <Section
        icon={<ComputeProviderIcon provider={provider.provider} />}
        title={
          <>
            <span>{provider.label}</span>
            {isDefault && (
              <Badge variant="success" className="ml-2">
                Default
              </Badge>
            )}
          </>
        }
      >
        {!expanded ? (
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
            <div>
              <p className="font-semibold text-sm">
                {credentialsHint
                  ? getCreateAccountHeading(provider)
                  : `Configure ${provider.label}`}
              </p>
              <p className="max-w-xl text-sm text-muted-foreground mt-1">
                {credentialsHint ? (
                  <>
                    {credentialsHint.map((segment, index) =>
                      typeof segment === 'string' ? (
                        <Fragment key={index}>{segment}</Fragment>
                      ) : (
                        <a
                          key={index}
                          className="underline underline-offset-4 hover:text-foreground"
                          href={segment.href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {segment.label}
                        </a>
                      ),
                    )}
                  </>
                ) : (
                  provider.description
                )}
              </p>
            </div>

            {hasNoInputFields && advancedInfraFields.length === 0 && (
              <div>
                <p className="font-semibold text-sm">Configuration values</p>
                <p className="text-sm text-muted-foreground mt-1">
                  No credentials needed.
                </p>
              </div>
            )}

            {inputFields.length > 0 && (
              <div>
                <p className="font-semibold text-sm">
                  {hasConfiguredValues
                    ? 'Configuration values'
                    : 'Enter the values below:'}
                </p>
                <div className="space-y-2 mt-2">
                  {inputFields.map((field) => renderFieldInput(field))}
                </div>
              </div>
            )}

            {advancedInfraFields.length > 0 && (
              <div>
                <p className="font-semibold text-sm">Provider infrastructure</p>
                <p className="max-w-xl text-sm text-muted-foreground mt-1">
                  {getAdvancedInfrastructureDescription({
                    provider,
                    hasMissingDefaultBlockingInfra,
                  })}
                </p>
                {hasMissingDefaultBlockingInfra && (
                  <p className="max-w-xl text-sm text-muted-foreground mt-1">
                    Add a registry-qualified hosted worker image above, or enter
                    the required provider artifact here before selecting{' '}
                    {provider.label} as the default.
                  </p>
                )}
                <div className="space-y-2 mt-3">
                  {advancedInfraFields.map((field) => {
                    const manualValue = values[field.envVarName]?.trim() ?? '';
                    const showProvisioningNote =
                      isProvisionableArtifactField(field) &&
                      manualValue.length === 0;

                    return (
                      <Fragment key={field.envVarName}>
                        {renderFieldInput(field)}
                        {showProvisioningNote && (
                          <div className="md:pl-[228px]">
                            {provisioningRunning ? (
                              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Spinner className="size-4 shrink-0" />
                                Provisioning the worker base image in your{' '}
                                {provider.label} account — this takes a couple
                                of minutes.
                              </span>
                            ) : provisioning?.status === 'failed' ? (
                              <span className="text-xs text-destructive">
                                Provisioning failed
                                {provisioning.error
                                  ? `: ${provisioning.error}`
                                  : '.'}{' '}
                                Save again to retry.
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Leave blank to provision automatically in your{' '}
                                {provider.label} account when saved.
                              </span>
                            )}
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {(inputFields.length > 0 || advancedInfraFields.length > 0) && (
              <EnvVarsInfoNote runtimeConfigured={runtimeConfigured} />
            )}

            {(hasSavedValues || hasEditableFields || canRetryProvisioning) &&
              (inputFields.length > 0 || advancedInfraFields.length > 0) && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {hasSavedValues && (
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
                  {(hasEditableFields || canRetryProvisioning) && (
                    <Button
                      type="button"
                      onClick={handleSave}
                      disabled={isActionDisabled || savePending}
                    >
                      <Check />
                      {savePending
                        ? 'Saving...'
                        : provisioningRunning
                          ? 'Provisioning...'
                          : canRetryProvisioning && !hasPendingValueChanges
                            ? 'Retry provisioning'
                            : 'Save'}
                      {savePending || provisioningRunning ? <Spinner /> : null}
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

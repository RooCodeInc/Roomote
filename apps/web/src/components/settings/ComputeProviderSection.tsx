'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  isAutoProvisionedComputeArtifactField,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isComputeOperatorEditableField,
  type ComputeProvider,
  type SetupComputeStatus,
  type SetupNewComputeProvisioningState,
} from '@roomote/types';

import { getComputeCredentialsHint } from '@/app/(onboarding)/setup/computeSetupCopy';
import {
  Alert,
  AlertCircle,
  AlertDescription,
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
  blaxel: 'blaxel',
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
    if (
      isSecretComputeField(field) ||
      field.runtimeSatisfied ||
      !isComputeOperatorEditableField(field)
    ) {
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
  // Optional operator-editable infrastructure (domain/region). Managed Modal
  // base image and E2B/Daytona artifacts are never form inputs.
  const optionalInfraFields = provider.fields.filter(
    (field) =>
      isComputeInfrastructureField(field) &&
      isComputeOperatorEditableField(field) &&
      !field.runtimeSatisfied,
  );
  // Keep the old name for the rest of this component without a big rename.
  const advancedInfraFields = optionalInfraFields;
  const missingDefaultBlockingInfraFields = provider.fields.filter(
    (field) =>
      isComputeInfrastructureField(field) &&
      field.required !== false &&
      !field.runtimeSatisfied &&
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
  // saved (E2B template build, Daytona snapshot registration, or Blaxel image build).
  const provisionableEnvOnlyFields = provider.fields.filter(
    (field) =>
      isAutoProvisionedComputeArtifactField(field) &&
      field.setupProvisionable &&
      !field.runtimeSatisfied &&
      !field.savedSatisfied,
  );
  const provisioningRunning = provisioning?.status === 'building';
  const provisioningFailed = provisioning?.status === 'failed';
  // Credentials are already satisfied when a save can still start or retry
  // auto-provisioning without retyping values (existing installs that later
  // gain a registry-qualified worker image).
  const credentialsSatisfiedForProvisioning = inputFields.every((field) => {
    const nextValue = values[field.envVarName]?.trim() ?? '';
    return (
      field.required === false ||
      field.runtimeSatisfied ||
      field.savedSatisfied ||
      nextValue.length > 0
    );
  });
  // A failed run is retried by saving again — even with no new values, as
  // long as the required credentials are already satisfied.
  const canRetryProvisioning =
    provisioning?.status === 'failed' &&
    provisionableEnvOnlyFields.length > 0 &&
    credentialsSatisfiedForProvisioning;
  // First-time (or re-)provisioning with already-saved credentials and no
  // field edits must still be actionable from Settings.
  const canStartProvisioning =
    provisionableEnvOnlyFields.length > 0 &&
    credentialsSatisfiedForProvisioning &&
    !provisioningRunning;

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
    (!hasPendingValueChanges && !canRetryProvisioning && !canStartProvisioning);

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

            {(inputFields.length > 0 || advancedInfraFields.length > 0) && (
              <div>
                <p className="font-semibold text-sm">
                  {hasConfiguredValues
                    ? 'Configuration values'
                    : 'Enter the values below:'}
                </p>
                {hasMissingDefaultBlockingInfra ? (
                  <p className="max-w-xl text-sm text-muted-foreground mt-1">
                    Configure a registry-qualified worker image via{' '}
                    <code className="font-mono text-xs">
                      DOCKER_WORKER_IMAGE
                    </code>{' '}
                    before selecting {provider.label} as the default.
                  </p>
                ) : null}
                <div className="space-y-2 mt-2">
                  {inputFields.map((field) => renderFieldInput(field))}
                  {advancedInfraFields.map((field) => renderFieldInput(field))}
                </div>
              </div>
            )}

            {(inputFields.length > 0 || advancedInfraFields.length > 0) && (
              <EnvVarsInfoNote runtimeConfigured={runtimeConfigured} />
            )}

            {provisioningFailed && (
              <Alert variant="destructive" className="max-w-xl">
                <AlertCircle />
                <AlertDescription>
                  {provisioning?.error
                    ? `Provisioning failed: ${provisioning.error}`
                    : 'Provisioning failed. Save to retry.'}
                </AlertDescription>
              </Alert>
            )}

            {provisioningRunning && (
              <p className="max-w-xl text-sm text-muted-foreground">
                Provisioning the worker base image. This can take a few minutes.
              </p>
            )}

            {(hasSavedValues ||
              hasEditableFields ||
              canRetryProvisioning ||
              canStartProvisioning) &&
              (inputFields.length > 0 ||
                advancedInfraFields.length > 0 ||
                canRetryProvisioning ||
                canStartProvisioning) && (
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
                  {(hasEditableFields ||
                    canRetryProvisioning ||
                    canStartProvisioning) && (
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

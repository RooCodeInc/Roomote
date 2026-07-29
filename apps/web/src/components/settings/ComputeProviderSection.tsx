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
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EnvVarsInfoNote,
  Input,
  Spinner,
  Switch,
  Trash2,
} from '@/components/system';
import { Section } from './Section';
import { DockerEnvironmentValidation } from './DockerEnvironmentValidation';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

const BRAND_ICON_BY_PROVIDER: Record<ComputeProvider, string> = {
  modal: 'modal',
  docker: 'docker',
  daytona: 'daytona',
  e2b: 'e2b',
  blaxel: 'blaxel',
  azure: 'azure',
  roomote: 'roomote',
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
  localDockerEnabled?: boolean;
  onLocalDockerToggle?: (enabled: boolean) => void;
  localDockerTogglePending?: boolean;
};

export function ComputeProviderSection({
  provider,
  isDefault,
  provisioning = null,
  onSave,
  onClear,
  savePending,
  clearPending,
  localDockerEnabled,
  onLocalDockerToggle,
  localDockerTogglePending = false,
}: ComputeProviderSectionProps) {
  const isLocalDocker = provider.provider === 'docker';
  const inputFields = provider.fields.filter(isComputeCredentialField);
  // Provider-specific routing, endpoint, and retention settings. Managed
  // worker artifacts are never form inputs. Runtime overrides remain visible
  // here but locked so operators can see where the effective policy comes from.
  const advancedInfraFields = provider.fields.filter(
    (field) =>
      isComputeInfrastructureField(field) &&
      isComputeOperatorEditableField(field) &&
      field.advanced,
  );
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
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setAdvancedExpanded(false);
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
  const retryableProvisionableFields = provider.fields.filter(
    (field) =>
      isAutoProvisionedComputeArtifactField(field) &&
      field.setupProvisionable &&
      !field.runtimeSatisfied,
  );
  const provisioningRunning = provisioning?.status === 'building';
  const provisioningRefresh = provisioningRunning && provider.configSatisfied;
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
    retryableProvisionableFields.length > 0 &&
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
    advancedInfraFields.some((field) => !field.runtimeSatisfied);
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
        <label
          htmlFor={`${provider.provider}-${field.envVarName}`}
          className="text-sm font-medium"
        >
          {field.label}
          {field.required === false ? ' (optional)' : ''}
        </label>
        <div className="flex items-center gap-2">
          {field.input?.type === 'select' ? (
            <select
              id={`${provider.provider}-${field.envVarName}`}
              className="font-mono flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={field.runtimeSatisfied ? '' : value}
              onChange={(event) => {
                const nextValue = event.target.value;
                setValues((current) => ({
                  ...current,
                  [field.envVarName]: nextValue,
                }));
              }}
              disabled={savePending || field.runtimeSatisfied}
            >
              <option value="">
                {field.runtimeSatisfied
                  ? 'Managed by environment variable'
                  : (field.input.placeholder ?? 'Default')}
              </option>
              {field.input.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label ?? option.value}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id={`${provider.provider}-${field.envVarName}`}
              secret={isSecretField && !field.runtimeSatisfied}
              type={isSecretField ? undefined : (field.input?.type ?? 'text')}
              min={field.input?.min}
              max={field.input?.max}
              step={field.input?.step}
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
              onChange={(event) => {
                const nextValue = event.target.value;
                setValues((current) => ({
                  ...current,
                  [field.envVarName]: nextValue,
                }));
              }}
              placeholder={
                field.runtimeSatisfied
                  ? 'Managed by environment variable'
                  : (field.input?.placeholder ?? field.label)
              }
              disabled={savePending || field.runtimeSatisfied}
              data-1p-ignore
            />
          )}
          {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
        </div>
        {field.helpText ? (
          <p className="text-xs text-muted-foreground md:col-start-2">
            {field.runtimeSatisfied
              ? `${field.helpText} Managed by ${field.envVarName}.`
              : field.helpText}
          </p>
        ) : null}
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
        {isLocalDocker && onLocalDockerToggle ? (
          <div className="flex items-start gap-4">
            <Switch
              checked={localDockerEnabled ?? true}
              onCheckedChange={onLocalDockerToggle}
              disabled={localDockerTogglePending}
              aria-label="Toggle Local Docker"
              className="mt-1"
            />
            <div>
              <p className="font-semibold">
                Enable Local Docker
                {localDockerTogglePending ? (
                  <span className="relative left-2 text-sm text-muted-foreground">
                    Saving...
                  </span>
                ) : null}
              </p>
              <p className="text-sm text-muted-foreground">
                Make Local Docker available as a sandbox provider for new tasks.
              </p>
            </div>
          </div>
        ) : null}

        {isLocalDocker && (localDockerEnabled ?? true) ? (
          <DockerEnvironmentValidation />
        ) : null}

        {(!isLocalDocker || (localDockerEnabled ?? true)) &&
          (!expanded ? (
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

              {hasNoInputFields && (
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
                  </div>
                </div>
              )}

              {advancedInfraFields.length > 0 ? (
                <Collapsible
                  open={advancedExpanded}
                  onOpenChange={setAdvancedExpanded}
                  className="max-w-xl"
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center justify-between rounded-md py-2 text-left text-sm font-semibold hover:text-accent-foreground"
                    >
                      <span>Advanced settings</span>
                      <ChevronDown
                        className={`size-4 transition-transform ${advancedExpanded ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pt-2">
                    <p className="text-sm text-muted-foreground">
                      Provider routing, endpoint, and standby retention
                      overrides. Leave optional values blank to use provider
                      defaults.
                    </p>
                    <div className="space-y-3">
                      {advancedInfraFields.map((field) =>
                        renderFieldInput(field),
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}

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
                  {provisioningRefresh
                    ? 'Updating the worker base image in the background. This can take several minutes; existing tasks keep using the current image until the replacement is ready.'
                    : 'Provisioning the worker base image. This can take several minutes and must finish before this provider can run tasks.'}
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
                        {savePending || provisioningRunning ? (
                          <Spinner />
                        ) : null}
                      </Button>
                    )}
                  </div>
                )}
            </div>
          ))}
      </Section>
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove {provider.label} configuration?</DialogTitle>
            <DialogDescription>
              Saved {provider.label} credentials and advanced settings will be
              removed from the database. Process environment variables are not
              affected.
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

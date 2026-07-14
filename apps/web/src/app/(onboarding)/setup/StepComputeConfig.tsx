'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deriveModalBaseImageRefDefault,
  getSetupNewComputeProvisioningState,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isComputeOperatorEditableField,
  isSetupProvisionableComputeProvider,
  type ComputeProvider,
  type SetupComputeStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowRight,
  Alert,
  AlertCircle,
  AlertDescription,
  Button,
  Check,
  ChevronDown,
  Input,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { getComputeCredentialsHint } from './computeSetupCopy';
import { getSetupStepDefinition } from './types';

const COMPUTE_CONFIG_STEP = getSetupStepDefinition('compute-config');
const MASKED_VALUE = '••••••••••••••••••••••••••••';
const SHARED_WORKER_IMAGE_ENV_VAR = 'DOCKER_WORKER_IMAGE';

function isSecretComputeField(field: { secret?: boolean }) {
  return field.secret === true;
}

function getNonSecretFieldInitialValues(
  fields: SetupComputeStatus['providers'][number]['fields'],
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

export function StepComputeConfig({
  computeSetup,
  selectedProviderId,
  onContinue,
  onBack,
}: {
  computeSetup: SetupComputeStatus;
  selectedProviderId?: ComputeProvider | null;
  onContinue: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const effectiveSelectedProviderId =
    selectedProviderId ??
    computeSetup.selectedProvider ??
    computeSetup.preselectedProvider;
  const selectedProviderFields = useMemo(() => {
    return (
      computeSetup.providers.find(
        (candidate) => candidate.provider === effectiveSelectedProviderId,
      )?.fields ?? []
    );
  }, [computeSetup.providers, effectiveSelectedProviderId]);
  const nonSecretInitialValuesKey = selectedProviderFields
    .filter((field) => !isSecretComputeField(field))
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}:${field.runtimeSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = useMemo(
    () => getNonSecretFieldInitialValues(selectedProviderFields),
    // selectedProviderFields is intentionally omitted; content key drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [nonSecretInitialValuesKey],
  );
  const [values, setValues] = useState<Record<string, string>>(
    nonSecretInitialValues,
  );
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const setupStatus = useQuery(trpc.setupNew.status.queryOptions());
  const templateBuild =
    effectiveSelectedProviderId &&
    isSetupProvisionableComputeProvider(effectiveSelectedProviderId) &&
    setupStatus.data
      ? getSetupNewComputeProvisioningState(
          setupStatus.data.setupNewState,
          effectiveSelectedProviderId,
        )
      : null;
  const selectedProvider = useMemo(
    () =>
      computeSetup.providers.find(
        (provider) => provider.provider === effectiveSelectedProviderId,
      ),
    [computeSetup.providers, effectiveSelectedProviderId],
  );
  const saveComputeConfig = useMutation(
    trpc.setupNew.saveComputeConfig.mutationOptions({
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

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
    setAdvancedExpanded(false);
  }, [effectiveSelectedProviderId, nonSecretInitialValues]);

  const credentialFields =
    selectedProvider?.fields.filter(isComputeCredentialField) ?? [];
  // Operator-editable infrastructure only (Modal base image, domain/region).
  // Auto-provisioned E2B template, Daytona snapshot, and Blaxel image refs are
  // not form inputs.
  const advancedInfraFields =
    selectedProvider?.fields.filter(
      (field) =>
        isComputeInfrastructureField(field) &&
        isComputeOperatorEditableField(field) &&
        !field.runtimeSatisfied,
    ) ?? [];
  // Hosted providers derive/provision their worker base image from a
  // registry-qualified worker image. Missing or editable worker image values
  // live in the advanced section instead of the primary credentials step.
  const isHostedProvider =
    selectedProvider !== undefined && selectedProvider.provider !== 'docker';
  const workerImage = computeSetup.workerImage;
  const workerImageValue = values[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ?? '';
  // Local tags (e.g. roomote-worker:local) satisfy Docker but not hosted
  // provisioning — only registry-qualified refs are hosted-ready.
  const submittedHostedWorkerImageReady =
    deriveModalBaseImageRefDefault(workerImageValue) !== null;
  const hostedWorkerImageReady =
    workerImage.hostedReady || submittedHostedWorkerImageReady;
  const missingHostedWorkerImage = isHostedProvider && !hostedWorkerImageReady;
  const canEditAdvancedWorkerImage =
    isHostedProvider && !workerImage.runtimeSatisfied;
  const shouldRenderAdvancedWorkerImage =
    canEditAdvancedWorkerImage &&
    (missingHostedWorkerImage || advancedExpanded);
  const shouldRenderAdvancedSettingsToggle =
    isHostedProvider && !missingHostedWorkerImage;

  const credentialsHint = selectedProvider
    ? getComputeCredentialsHint(selectedProvider.provider)
    : null;

  // Hosted providers need a pullable (registry-qualified) worker image. A bare
  // process-env local tag must not enable Save — Modal/E2B/Daytona derive or
  // provision from that image server-side, not from form base-image fields.
  const hostedRequirementMet = !isHostedProvider || hostedWorkerImageReady;

  const credentialsMet = credentialFields.every(
    (field) =>
      field.required === false ||
      field.runtimeSatisfied ||
      field.savedSatisfied ||
      (values[field.envVarName]?.trim() ?? '').length > 0,
  );

  const hasTypedValues = Object.values(values).some(
    (value) => value.trim().length > 0,
  );
  const canContinueWithoutNewValues =
    credentialFields.every(
      (field) =>
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied,
    ) &&
    (!isHostedProvider ||
      workerImage.hostedReady ||
      (selectedProvider?.fields
        .filter(
          (field) =>
            isComputeInfrastructureField(field) &&
            isComputeOperatorEditableField(field) &&
            field.advanced,
        )
        .some((field) => field.savedSatisfied) ??
        false));

  const shouldRenderAdvancedSettings =
    isHostedProvider && (missingHostedWorkerImage || advancedExpanded);

  const templateBuildFailed = templateBuild?.status === 'failed';
  const templateBuildRunning = templateBuild?.status === 'building';

  const isActionDisabled =
    saveComputeConfig.isPending ||
    !selectedProvider ||
    !credentialsMet ||
    !hostedRequirementMet;

  const handleContinue = async () => {
    if (!selectedProvider) {
      return;
    }

    await saveComputeConfig.mutateAsync({
      provider: selectedProvider.provider,
      values,
    });
  };

  const renderInputField = (field: {
    envVarName: string;
    label: string;
    required?: boolean;
    secret?: boolean;
    runtimeSatisfied?: boolean;
    savedSatisfied?: boolean;
    savedValue?: string | null;
  }) => {
    const value = values[field.envVarName] ?? '';
    const isSecretField = isSecretComputeField(field);
    const shouldShowSavedValueMask =
      isSecretField &&
      !field.runtimeSatisfied &&
      !!field.savedSatisfied &&
      value.length === 0 &&
      !editingSavedValues[field.envVarName];

    return (
      <div
        key={field.envVarName}
        className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center max-w-xl"
      >
        <div className="text-sm font-medium">
          {field.label}
          {field.required === false ? ' (opt)' : ''}
        </div>
        <div className="flex items-center gap-2">
          <Input
            secret={isSecretField && !field.runtimeSatisfied}
            type={isSecretField ? undefined : 'text'}
            className="font-mono disabled:bg-card/90 disabled:text-foreground/50"
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
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.envVarName]: event.target.value,
              }))
            }
            placeholder={field.runtimeSatisfied ? '' : field.envVarName}
            disabled={saveComputeConfig.isPending || field.runtimeSatisfied}
            data-1p-ignore
          />
          {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
        </div>
      </div>
    );
  };

  return (
    <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
      <StepTitle text={COMPUTE_CONFIG_STEP.title} />

      <div className="space-y-5 mt-6">
        <div className="flex gap-2 items-start">
          <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
            1
          </span>
          <div className="min-w-0 flex-1 space-y-2 mt-2">
            {selectedProvider && credentialFields.length > 0 ? (
              <>
                <p className="font-semibold">
                  Create {selectedProvider.label === 'E2B' ? 'an' : 'a'}{' '}
                  {selectedProvider.label} account.
                </p>
                {credentialsHint ? (
                  <p className="text-sm text-muted-foreground">
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
                  </p>
                ) : null}
              </>
            ) : (
              <p className="font-semibold">
                {selectedProvider?.label ?? 'This provider'} does not need any
                account credentials.
              </p>
            )}
          </div>
        </div>

        {selectedProvider && credentialFields.length > 0 ? (
          <div className="flex gap-2 items-start">
            <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
              2
            </span>
            <div className="min-w-0 flex-1 space-y-2 mt-2">
              <p className="font-semibold">Enter the configuration values</p>
              {credentialFields.length > 0 ? (
                <div className="space-y-2">
                  {credentialFields.map((field) => renderInputField(field))}
                </div>
              ) : null}

              {isHostedProvider && workerImage.hostedReady ? (
                <div className="flex items-start gap-2 text-muted-foreground mt-4">
                  <Check className="inline size-4 mt-0.5 shrink-0 text-foreground" />
                  <p className="text-sm">
                    Roomote already has a published worker image for hosted
                    sandboxes.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {shouldRenderAdvancedSettings ? (
          <div className="flex gap-2 items-start">
            <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
              3
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-semibold">
                  Advanced {selectedProvider?.label} settings
                </p>
                <p className="text-sm text-muted-foreground">
                  Only change these if you know what you are doing.
                </p>
              </div>

              {shouldRenderAdvancedWorkerImage ? (
                <div className="space-y-1 max-w-xl">
                  <div className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center">
                    <div className="text-sm font-medium">
                      Roomote worker image
                    </div>
                    <Input
                      className="font-mono"
                      value={values[SHARED_WORKER_IMAGE_ENV_VAR] ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [SHARED_WORKER_IMAGE_ENV_VAR]: event.target.value,
                        }))
                      }
                      placeholder="ghcr.io/roocodeinc/roomote-worker:tag"
                      disabled={saveComputeConfig.isPending}
                      data-1p-ignore
                    />
                  </div>
                  <p className="text-xs text-muted-foreground md:pl-[228px]">
                    Use a registry path that hosted providers can pull, for
                    example a GHCR image tag.
                  </p>
                </div>
              ) : workerImage.hostedReady ? (
                <div className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center max-w-xl">
                  <div className="text-sm font-medium">
                    Roomote worker image
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check className="size-4 shrink-0 text-foreground" />
                    <span>
                      {workerImage.hostedImageRef
                        ? workerImage.hostedImageRef
                        : 'Configured'}
                    </span>
                  </div>
                </div>
              ) : missingHostedWorkerImage ? (
                <div className="space-y-1 max-w-xl">
                  <div className="text-sm font-medium">
                    Roomote worker image
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Hosted providers need a registry-qualified worker image (for
                    example{' '}
                    <code className="font-mono text-xs">
                      ghcr.io/roocodeinc/roomote-worker:tag
                    </code>
                    ). A local tag such as{' '}
                    <code className="font-mono text-xs">
                      roomote-worker:local
                    </code>{' '}
                    only works on this host. Set{' '}
                    <code className="font-mono text-xs">
                      DOCKER_WORKER_IMAGE
                    </code>{' '}
                    to a pullable image before continuing.
                  </p>
                </div>
              ) : null}

              {advancedInfraFields.length > 0 ? (
                <div className="space-y-2 pt-2">
                  {advancedInfraFields.map((field) =>
                    renderInputField({ ...field, required: false }),
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {shouldRenderAdvancedSettingsToggle ? (
          <button
            type="button"
            className={`text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer ${advancedExpanded && 'pl-10'}`}
            onClick={() => setAdvancedExpanded((current) => !current)}
          >
            {advancedExpanded
              ? 'Hide advanced options'
              : 'Show advanced options'}
            <ChevronDown
              className={`${advancedExpanded && 'rotate-180'} inline size-4 transition-all`}
            />
          </button>
        ) : null}
      </div>

      {templateBuildRunning ? (
        <p className="text-sm text-muted-foreground mt-8">
          Provisioning the worker base image in the background. You can continue
          while Roomote prepares the sandbox provider.
        </p>
      ) : null}

      {templateBuildFailed ? (
        <Alert variant="destructive" className="mt-8">
          <AlertCircle />
          <AlertDescription>
            {templateBuild.error
              ? `Provisioning failed: ${templateBuild.error}`
              : 'Provisioning failed. Retry to prepare this sandbox provider.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <SetupFooter
        onBack={onBack}
        backDisabled={saveComputeConfig.isPending}
        className={
          templateBuildRunning || templateBuildFailed ? 'mt-2' : 'mt-8'
        }
      >
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={isActionDisabled}
        >
          {saveComputeConfig.isPending
            ? 'Saving...'
            : templateBuildFailed
              ? 'Retry provisioning'
              : !hasTypedValues && canContinueWithoutNewValues
                ? 'Continue'
                : 'Save and continue'}
          {saveComputeConfig.isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </SetupFooter>
    </div>
  );
}

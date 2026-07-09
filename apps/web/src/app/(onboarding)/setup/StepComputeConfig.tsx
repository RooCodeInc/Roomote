'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getSetupNewComputeProvisioningState,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isSetupProvisionableComputeProvider,
  type ComputeProvider,
  type SetupComputeStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  Button,
  Check,
  ChevronDown,
  EnvVarsInfoNote,
  Input,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
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
  // Set while the deployment is provisioning the worker base image in the
  // operator's provider account; the step stays put and polls until it lands.
  const [awaitingTemplateBuild, setAwaitingTemplateBuild] = useState(false);
  const setupStatus = useQuery(
    trpc.setupNew.status.queryOptions(undefined, {
      refetchInterval: awaitingTemplateBuild ? 2_000 : false,
    }),
  );
  const templateBuild =
    effectiveSelectedProviderId &&
    isSetupProvisionableComputeProvider(effectiveSelectedProviderId) &&
    setupStatus.data
      ? getSetupNewComputeProvisioningState(
          setupStatus.data.setupNewState,
          effectiveSelectedProviderId,
        )
      : null;
  const saveComputeConfig = useMutation(
    trpc.setupNew.saveComputeConfig.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });

        const resultProvisioning =
          selectedProvider &&
          isSetupProvisionableComputeProvider(selectedProvider.provider)
            ? getSetupNewComputeProvisioningState(
                result.setupNewState,
                selectedProvider.provider,
              )
            : null;

        if (resultProvisioning?.status === 'building') {
          setAwaitingTemplateBuild(true);
          return;
        }

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
    setAwaitingTemplateBuild(false);
  }, [effectiveSelectedProviderId, nonSecretInitialValues]);

  // Re-attach to an in-flight build (e.g. after a page reload mid-build).
  useEffect(() => {
    if (templateBuild?.status === 'building') {
      setAwaitingTemplateBuild(true);
    }
  }, [templateBuild?.status]);

  useEffect(() => {
    if (!awaitingTemplateBuild) {
      return;
    }

    if (templateBuild?.status === 'succeeded') {
      setAwaitingTemplateBuild(false);
      void queryClient
        .invalidateQueries({ queryKey: trpc.setupNew.status.queryKey() })
        .then(() => onContinue());
    } else if (templateBuild?.status === 'failed') {
      setAwaitingTemplateBuild(false);
      toast.error(
        templateBuild.error ?? 'Provisioning the worker base image failed.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingTemplateBuild, templateBuild?.status]);

  const selectedProvider = useMemo(
    () =>
      computeSetup.providers.find(
        (provider) => provider.provider === effectiveSelectedProviderId,
      ),
    [computeSetup.providers, effectiveSelectedProviderId],
  );

  const credentialFields =
    selectedProvider?.fields.filter(isComputeCredentialField) ?? [];
  const advancedInfraFields =
    selectedProvider?.fields.filter(
      (field) => isComputeInfrastructureField(field) && !field.runtimeSatisfied,
    ) ?? [];
  // Hosted providers derive/provision their worker base image from the shared
  // worker image. Missing or editable worker image values live in the advanced
  // section instead of the primary credentials step.
  const isHostedProvider =
    selectedProvider?.fields.some(isComputeInfrastructureField) ?? false;
  const workerImage = computeSetup.workerImage;
  const missingHostedWorkerImage =
    isHostedProvider &&
    !workerImage.runtimeSatisfied &&
    !workerImage.hostedReady;
  const canEditAdvancedWorkerImage =
    isHostedProvider && !workerImage.runtimeSatisfied;
  const shouldRenderAdvancedWorkerImage =
    canEditAdvancedWorkerImage &&
    (missingHostedWorkerImage || advancedExpanded);
  const shouldRenderAdvancedSettingsToggle =
    isHostedProvider && !missingHostedWorkerImage;
  const workerImageValue = values[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ?? '';
  const workerImageAvailable =
    workerImage.runtimeSatisfied ||
    workerImage.hostedReady ||
    workerImageValue.length > 0;

  const credentialsHint = selectedProvider
    ? getComputeCredentialsHint(selectedProvider.provider)
    : null;

  const provisionableProvider =
    selectedProvider &&
    isSetupProvisionableComputeProvider(selectedProvider.provider)
      ? selectedProvider.provider
      : null;
  const artifactEnvVar =
    provisionableProvider === 'e2b'
      ? 'E2B_TEMPLATE_ID'
      : provisionableProvider === 'daytona'
        ? 'DAYTONA_SNAPSHOT_NAME'
        : null;
  const manualArtifactValue = artifactEnvVar
    ? (values[artifactEnvVar]?.trim() ?? '')
    : '';
  const manualModalBaseImage =
    selectedProvider?.provider === 'modal'
      ? (values.MODAL_BASE_IMAGE_REF?.trim() ?? '')
      : '';

  // A hosted provider needs a worker image to derive/provision its base image,
  // unless the operator supplies a manual provider artifact directly.
  const hostedRequirementMet =
    !isHostedProvider ||
    workerImageAvailable ||
    manualArtifactValue.length > 0 ||
    manualModalBaseImage.length > 0;

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
      workerImage.runtimeSatisfied ||
      workerImage.hostedReady ||
      (selectedProvider?.fields
        .filter(
          (field) => isComputeInfrastructureField(field) && field.advanced,
        )
        .some((field) => field.savedSatisfied) ??
        false));

  // Provisionable worker images build automatically once credentials + a
  // worker image are saved and no manual artifact was supplied.
  const showProvisioningNotice =
    !!provisionableProvider &&
    manualArtifactValue.length === 0 &&
    (workerImageAvailable || awaitingTemplateBuild) &&
    !selectedProvider?.fields.find(
      (field) => field.envVarName === artifactEnvVar,
    )?.savedSatisfied &&
    !selectedProvider?.fields.find(
      (field) => field.envVarName === artifactEnvVar,
    )?.runtimeSatisfied;
  const shouldRenderAdvancedSettings =
    isHostedProvider && (missingHostedWorkerImage || advancedExpanded);

  const templateBuildFailed = templateBuild?.status === 'failed';

  const isActionDisabled =
    saveComputeConfig.isPending ||
    awaitingTemplateBuild ||
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
                ? ''
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

              {!advancedExpanded && <EnvVarsInfoNote />}

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
              ) : null}

              {showProvisioningNotice ? (
                <div className="mt-6 grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center max-w-xl">
                  <div className="text-sm font-medium">Worker base image</div>
                  <div className="flex items-center gap-2 text-sm">
                    {awaitingTemplateBuild ? (
                      <>
                        <Spinner className="size-4 shrink-0" />
                        <span className="text-xs text-muted-foreground">
                          Provisioning the worker base image in your{' '}
                          {selectedProvider?.label ?? 'provider'} account — this
                          takes a couple of minutes.
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Added automatically to your{' '}
                        {selectedProvider?.label ?? 'provider'} account when you
                        save.
                      </span>
                    )}
                  </div>
                </div>
              ) : null}

              {advancedInfraFields.length > 0 ? (
                <div className="space-y-2 pt-2">
                  {advancedInfraFields.map((field) =>
                    renderInputField({ ...field, required: false }),
                  )}
                </div>
              ) : null}

              {advancedExpanded && <EnvVarsInfoNote />}
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
        {onBack ? (
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={saveComputeConfig.isPending || awaitingTemplateBuild}
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
          {awaitingTemplateBuild
            ? 'Provisioning...'
            : saveComputeConfig.isPending
              ? 'Saving...'
              : templateBuildFailed
                ? 'Retry provisioning'
                : !hasTypedValues && canContinueWithoutNewValues
                  ? 'Continue'
                  : 'Save and continue'}
          {saveComputeConfig.isPending || awaitingTemplateBuild ? (
            <Spinner />
          ) : (
            <ArrowRight />
          )}
        </Button>
      </div>
    </div>
  );
}

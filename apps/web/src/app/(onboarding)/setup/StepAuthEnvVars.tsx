'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { SetupAuthStatus } from '@roomote/types';

import { authClient } from '@/lib/auth-client';
import { getAuthProviderCallbackUrl } from '@/lib/auth-provider-callback';
import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  BrandIcon,
  Button,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import {
  getSetupEffectiveFieldValue,
  getSetupSubmitValues,
  getSetupVisibleFields,
  ProviderSetupExperience,
} from './ProviderSetupExperience';

/** Microsoft app (client) IDs are GUIDs. */
const MICROSOFT_APP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOTSTRAP_SIGN_IN_CALLBACK_PATH = '/setup';

function getOAuth2ProviderId(
  providerId: SetupAuthStatus['preselectedProvider'],
): string | null {
  switch (providerId) {
    case 'slack':
      return providerId;
    case 'microsoft':
      return 'microsoft-entra-id';
    default:
      return null;
  }
}

export function StepAuthEnvVars({
  authSetup,
  selectedProviderId,
  onContinue,
  onBack,
  bootstrapMode = false,
  setupToken = null,
}: {
  authSetup: SetupAuthStatus;
  selectedProviderId?: SetupAuthStatus['preselectedProvider'] | null;
  onContinue: () => void;
  onBack?: () => void;
  bootstrapMode?: boolean;
  setupToken?: string | null;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const effectiveSelectedProviderId =
    selectedProviderId ??
    authSetup.selectedProvider ??
    authSetup.preselectedProvider;
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [clearedSavedValues, setClearedSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [showMicrosoftAdvancedConfig, setShowMicrosoftAdvancedConfig] =
    useState(false);
  const saveAuthConfig = useMutation(
    (bootstrapMode
      ? trpc.setupBootstrap.saveAuthConfig
      : trpc.setupNew.saveAuthConfig
    ).mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: bootstrapMode
            ? trpc.setupBootstrap.status.queryKey()
            : trpc.setupNew.status.queryKey(),
        });
        if (bootstrapMode && selectedProvider) {
          const callbackURL = getAuthProviderCallbackUrl(
            selectedProvider.id,
            BOOTSTRAP_SIGN_IN_CALLBACK_PATH,
          );
          const oauth2ProviderId = getOAuth2ProviderId(selectedProvider.id);
          const result = oauth2ProviderId
            ? await authClient.signIn.oauth2({
                providerId: oauth2ProviderId,
                callbackURL,
                disableRedirect: true,
              })
            : await authClient.signIn.social({
                provider: selectedProvider.id,
                callbackURL,
                disableRedirect: true,
              });

          if (result.error) {
            toast.error(result.error.message || 'Unable to sign in.');
            return;
          }

          if (result.data?.url) {
            window.location.assign(result.data.url);
            return;
          }

          router.replace(callbackURL);
          router.refresh();
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
    setValues({});
    setEditingSavedValues({});
    setClearedSavedValues({});
    setShowMicrosoftAdvancedConfig(false);
  }, [effectiveSelectedProviderId]);

  const selectedProvider = useMemo(
    () =>
      authSetup.providers.find(
        (provider) => provider.id === effectiveSelectedProviderId,
      ),
    [authSetup.providers, effectiveSelectedProviderId],
  );
  const visibleFields = useMemo(
    () =>
      getSetupVisibleFields(selectedProvider ?? null, {
        showMicrosoftAdvancedConfig,
      }),
    [selectedProvider, showMicrosoftAdvancedConfig],
  );
  const isMicrosoftProvider = selectedProvider?.id === 'microsoft';

  const canContinueWithoutNewValues =
    visibleFields.every(
      (field) =>
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied,
    ) ?? false;

  const isActionDisabled =
    saveAuthConfig.isPending ||
    !selectedProvider ||
    visibleFields.some((field) => {
      const nextValue = getSetupEffectiveFieldValue({
        provider: selectedProvider,
        field,
        values,
      }).trim();

      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        nextValue.length === 0
      );
    });

  const handleContinue = async () => {
    if (!selectedProvider) {
      return;
    }

    await saveAuthConfig.mutateAsync({
      provider: selectedProvider.id,
      values: getSetupSubmitValues({
        provider: selectedProvider,
        values,
        showMicrosoftAdvancedConfig,
      }),
      ...(bootstrapMode && setupToken ? { setupToken } : {}),
    });
  };

  const provider = selectedProvider?.label;
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const teamsBotAppIdField = selectedProvider?.fields.find(
    (field) => field.envVarName === 'R_TEAMS_BOT_APP_ID',
  );
  const teamsBotNameField = selectedProvider?.fields.find(
    (field) => field.envVarName === 'R_TEAMS_BOT_NAME',
  );
  const enteredTeamsBotAppId =
    isMicrosoftProvider && teamsBotAppIdField
      ? getSetupEffectiveFieldValue({
          provider: selectedProvider,
          field: teamsBotAppIdField,
          values,
        }).trim()
      : '';
  const typedTeamsBotAppId = MICROSOFT_APP_ID_PATTERN.test(enteredTeamsBotAppId)
    ? enteredTeamsBotAppId
    : '';
  const typedTeamsBotName =
    isMicrosoftProvider && teamsBotNameField
      ? getSetupEffectiveFieldValue({
          provider: selectedProvider,
          field: teamsBotNameField,
          values,
        }).trim()
      : '';
  const teamsBotAppIdStored = isMicrosoftProvider
    ? selectedProvider.fields.some(
        (field) =>
          (field.envVarName === 'R_TEAMS_BOT_APP_ID' ||
            field.envVarName === 'R_MICROSOFT_CLIENT_ID') &&
          (field.runtimeSatisfied || field.savedSatisfied),
      )
    : false;
  const teamsSetupPackageParams = new URLSearchParams();
  if (typedTeamsBotAppId) {
    teamsSetupPackageParams.set('botAppId', typedTeamsBotAppId);
  }
  if (typedTeamsBotName) {
    teamsSetupPackageParams.set('botName', typedTeamsBotName);
  }
  const teamsAppPackageHref = typedTeamsBotAppId
    ? `/api/setup/teams-app-package?${teamsSetupPackageParams.toString()}`
    : !bootstrapMode && teamsBotAppIdStored
      ? '/api/teams/app-package'
      : null;
  const [showManualSlackValues, setShowManualSlackValues] = useState(false);

  useEffect(() => {
    setShowManualSlackValues(false);
  }, [effectiveSelectedProviderId]);

  const selectedProviderRuntimeConfigured =
    authSetup.lockReason === 'runtime_env' &&
    authSetup.runtimeConfiguredProvider === selectedProvider?.id &&
    selectedProvider.runtimeSatisfied;
  const selectedProviderHasEditableFields =
    visibleFields.some((field) => !field.runtimeSatisfied) ?? false;
  // Slack "owns" the step actions only while its intro screen is shown, which
  // is the same condition SlackSetupExperience uses to render that intro. If a
  // saved (or runtime) config is being edited instead, the intro is hidden and
  // this step must render its own action button — otherwise there is no way to
  // continue. Keep this in sync with SlackSetupExperience's intro guard.
  const providerOwnsActions =
    selectedProvider?.id === 'slack' &&
    !showManualSlackValues &&
    !selectedProvider.runtimeSatisfied &&
    !selectedProvider.savedSatisfied;

  if (bootstrapMode && selectedProviderRuntimeConfigured) {
    return (
      <div className="relative w-full max-w-xl space-y-4 py-2 md:py-0">
        <StepTitle text={`Sign in with ${provider ?? 'your provider'}`} />

        <p>
          This deployment is already configured for {provider}, so let&apos;s go
          with it (you can configure other comms providers later).
        </p>
        <p>Sign in to continue setup.</p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          <Button
            type="button"
            onClick={() => void handleContinue()}
            disabled={saveAuthConfig.isPending}
          >
            <BrandIcon
              icon={selectedProvider.id}
              name=""
              className="size-4 shrink-0"
            />
            Sign in with {provider}
            {saveAuthConfig.isPending ? <Spinner /> : <ArrowRight />}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
      {selectedProvider ? (
        <ProviderSetupExperience
          provider={selectedProvider}
          values={values}
          publicOrigin={publicOrigin}
          disabled={saveAuthConfig.isPending}
          editingSavedValues={editingSavedValues}
          clearedSavedValues={clearedSavedValues}
          teamsAppPackageHref={teamsAppPackageHref}
          showManualSlackValues={showManualSlackValues}
          showMicrosoftAdvancedConfig={showMicrosoftAdvancedConfig}
          onShowManualSlackValues={() => setShowManualSlackValues(true)}
          onToggleMicrosoftAdvancedConfig={() =>
            setShowMicrosoftAdvancedConfig((current) => !current)
          }
          onBack={onBack}
          onValueChange={(envVarName, value) =>
            setValues((current) => ({ ...current, [envVarName]: value }))
          }
          onEditingSavedValueChange={(envVarName, editing) =>
            setEditingSavedValues((current) => ({
              ...current,
              [envVarName]: editing,
            }))
          }
          onClearedSavedValueChange={(envVarName, cleared) =>
            setClearedSavedValues((current) => ({
              ...current,
              [envVarName]: cleared,
            }))
          }
        />
      ) : null}

      {providerOwnsActions ? null : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          {onBack ? (
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={saveAuthConfig.isPending}
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
            {saveAuthConfig.isPending
              ? 'Saving...'
              : !selectedProviderHasEditableFields
                ? 'Continue'
                : bootstrapMode
                  ? 'Save and sign in'
                  : canContinueWithoutNewValues
                    ? 'Continue'
                    : 'Save and continue'}
            {saveAuthConfig.isPending ? <Spinner /> : <ArrowRight />}
          </Button>
        </div>
      )}
    </div>
  );
}

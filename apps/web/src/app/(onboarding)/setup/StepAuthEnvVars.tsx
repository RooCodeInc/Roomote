'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { SetupAuthStatus } from '@roomote/types';

import { authClient } from '@/lib/auth-client';
import { getAuthProviderCallbackUrl } from '@/lib/auth-provider-callback';
import { buildSlackManifestPrefillUrl } from '@/lib/slack-app-manifest';
import {
  SLACK_APP_INSTALL_CALLBACK_PATH,
  SLACK_SIGN_IN_CALLBACK_PATH,
} from '@/lib/slack-callback-paths';
import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  BrandIcon,
  Button,
  Check,
  EnvVarsInfoNote,
  ExternalLink,
  Input,
  Pencil,
  Sparkles,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { getProviderSetupCopy } from './providerSetupCopy';
const MASKED_VALUE = '••••••••••••••••••••••••••••';

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
            '/setup',
          );
          const oauth2ProviderId = getOAuth2ProviderId(selectedProvider.id);
          const result = oauth2ProviderId
            ? await authClient.signIn.oauth2({
                providerId: oauth2ProviderId,
                callbackURL,
              })
            : await authClient.signIn.social({
                provider: selectedProvider.id,
                callbackURL,
              });

          if (result.error) {
            toast.error(result.error.message || 'Unable to sign in.');
            return;
          }

          if (!result.data?.url) {
            router.replace(callbackURL);
            router.refresh();
          }

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
  }, [effectiveSelectedProviderId]);

  const selectedProvider = useMemo(
    () =>
      authSetup.providers.find(
        (provider) => provider.id === effectiveSelectedProviderId,
      ),
    [authSetup.providers, effectiveSelectedProviderId],
  );
  const canContinueWithoutNewValues =
    selectedProvider?.fields.every(
      (field) =>
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied,
    ) ?? false;

  const isActionDisabled =
    saveAuthConfig.isPending ||
    !selectedProvider ||
    selectedProvider.fields.some((field) => {
      const nextValue = values[field.envVarName]?.trim() ?? '';

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
      values,
      ...(bootstrapMode && setupToken ? { setupToken } : {}),
    });
  };

  const provider = selectedProvider?.label;
  const providerSetupCopy = selectedProvider
    ? getProviderSetupCopy(selectedProvider.id)
    : null;
  const providerSetupLabel = providerSetupCopy?.setupLabel ?? `${provider} app`;
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const slackManifestPrefillUrl =
    selectedProvider?.id === 'slack'
      ? buildSlackManifestPrefillUrl({ publicOrigin })
      : null;
  const [showManualSlackValues, setShowManualSlackValues] = useState(false);
  const providerSetupNotes = useMemo(() => {
    if (!selectedProvider) {
      return providerSetupCopy?.notes ?? [];
    }

    if (selectedProvider.id !== 'slack') {
      return providerSetupCopy?.notes ?? [];
    }

    return [
      `Register these as authorized redirect URLs (under OAuth & Permissions):`,
      `${publicOrigin}${SLACK_SIGN_IN_CALLBACK_PATH}`,
      `${publicOrigin}${SLACK_APP_INSTALL_CALLBACK_PATH}`,
    ];
  }, [providerSetupCopy?.notes, publicOrigin, selectedProvider]);

  useEffect(() => {
    setShowManualSlackValues(false);
  }, [effectiveSelectedProviderId]);

  const selectedProviderRuntimeConfigured =
    authSetup.lockReason === 'runtime_env' &&
    authSetup.runtimeConfiguredProvider === selectedProvider?.id &&
    selectedProvider.runtimeSatisfied;
  const selectedProviderHasEditableFields =
    selectedProvider?.fields.some((field) => !field.runtimeSatisfied) ?? false;

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

  if (
    selectedProvider?.id === 'slack' &&
    !showManualSlackValues &&
    !selectedProvider.runtimeSatisfied
  ) {
    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <StepTitle text="Create Slack app" />

        <div className="space-y-3 max-w-xl">
          <p>
            Because Roomote is self-hosted, we can&apos;t offer you an
            out-of-the-box Slack app – you need to create your own.
          </p>
          <p>
            Roomote can create it for you automatically, and then you can enter
            the config values manually.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          {onBack ? (
            <Button type="button" variant="outline" onClick={onBack}>
              <ArrowLeft />
              Back
            </Button>
          ) : null}
          <Button asChild>
            <a
              href={slackManifestPrefillUrl ?? 'https://api.slack.com/apps'}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setShowManualSlackValues(true)}
            >
              <Sparkles />
              Create Slack app
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowManualSlackValues(true)}
          >
            <Pencil />
            Enter values manually
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
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
                <Button variant="outline" size="sm" className="ml-2">
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
              <>create a new {providerSetupLabel}.</>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            If you need our logo,{' '}
            <Link
              className="underline underline-offset-4 hover:text-foreground"
              href="/api/setup/roomote-logo"
            >
              download here
            </Link>
            .
          </p>
        </div>
      </div>

      {providerSetupNotes.length > 0 && (
        <div className="flex gap-2 items-start">
          <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
            2
          </span>
          <p className="font-semibold">
            {providerSetupNotes.map((note) => (
              <span className="block" key={note}>
                {note}
              </span>
            ))}
          </p>
        </div>
      )}

      <div className="flex gap-2 items-start">
        <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
          {providerSetupNotes.length > 0 ? 3 : 2}
        </span>
        <div>
          <p className="font-semibold">Enter the values below:</p>
          <div className="space-y-2">
            {selectedProvider?.fields.map((field) => {
              const value = values[field.envVarName] ?? '';
              const shouldShowSavedValueMask =
                !field.runtimeSatisfied &&
                field.savedSatisfied &&
                value.length === 0 &&
                !clearedSavedValues[field.envVarName] &&
                !editingSavedValues[field.envVarName];

              return (
                <div
                  key={field.envVarName}
                  className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center max-w-xl"
                >
                  <div className="space-y-1">
                    <div className="text-sm font-medium">
                      {field.label}
                      {field.required === false ? ' (optional)' : ''}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <Input
                        secret={field.secret && !field.runtimeSatisfied}
                        className="font-mono"
                        value={
                          field.runtimeSatisfied
                            ? MASKED_VALUE
                            : shouldShowSavedValueMask
                              ? MASKED_VALUE
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
                          if (field.savedSatisfied && value.length === 0) {
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
                          if (field.savedSatisfied) {
                            setClearedSavedValues((current) => ({
                              ...current,
                              [field.envVarName]: nextValue.length === 0,
                            }));
                          }
                        }}
                        placeholder={field.runtimeSatisfied ? '' : field.label}
                        disabled={
                          saveAuthConfig.isPending || field.runtimeSatisfied
                        }
                        data-1p-ignore
                      />
                      {(field.runtimeSatisfied || field.savedSatisfied) && (
                        <Check />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="space-y-2 text-sm text-muted-foreground">
              <EnvVarsInfoNote
                runtimeConfigured={selectedProvider?.runtimeSatisfied}
              />
            </div>
          </div>
        </div>
      </div>

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
    </div>
  );
}

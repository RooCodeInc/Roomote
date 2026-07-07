'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import type {
  SetupSourceControlStatus,
  SourceControlProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  Button,
  Check,
  CopyIconButton,
  EnvVarsInfoNote,
  ExternalLink,
  Input,
  Label,
  Pencil,
  Sparkles,
  Spinner,
} from '@/components/system';
import { useCreateGitHubAppManifest } from '@/hooks/github';

import { StepTitle } from './StepTitle';
import { getSourceControlSetupCopy } from './sourceControlSetupCopy';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

type GitHubAppManifestForm = {
  postTarget: string;
  values: {
    manifest: string;
  };
};

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
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [showManualGitHubValues, setShowManualGitHubValues] = useState(false);
  const [githubOrganization, setGithubOrganization] = useState('');
  const [manifestForm, setManifestForm] =
    useState<GitHubAppManifestForm | null>(null);
  const manifestFormRef = useRef<HTMLFormElement | null>(null);
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
  const createGitHubAppManifest = useCreateGitHubAppManifest({
    onSuccess: (result) => {
      if (result.success) {
        setManifestForm(result);
      } else {
        toast.error(result.error);
      }
    },
    onError: () =>
      toast.error('Failed to start GitHub App creation. Please try again.'),
  });

  useEffect(() => {
    setValues({});
    setEditingSavedValues({});
    setShowManualGitHubValues(false);
    setGithubOrganization('');
    setManifestForm(null);
  }, [effectiveSelectedProviderId]);

  useEffect(() => {
    if (manifestForm) {
      manifestFormRef.current?.submit();
    }
  }, [manifestForm]);

  const selectedProvider = useMemo(
    () =>
      sourceControlSetup.providers.find(
        (provider) => provider.provider === effectiveSelectedProviderId,
      ),
    [sourceControlSetup.providers, effectiveSelectedProviderId],
  );
  const canContinueWithoutNewValues =
    selectedProvider?.fields.every(
      (field) =>
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied,
    ) ?? false;

  const isActionDisabled =
    saveSourceControlConfig.isPending ||
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

    await saveSourceControlConfig.mutateAsync({
      provider: selectedProvider.provider,
      values,
    });
  };

  const provider = selectedProvider?.label;
  const providerSetupCopy = selectedProvider
    ? getSourceControlSetupCopy(selectedProvider.provider)
    : null;
  const providerSetupLabel = providerSetupCopy?.setupLabel ?? 'source control';
  const isGitHubManifestDefault =
    selectedProvider?.provider === 'github' && !showManualGitHubValues;
  const isGitLab = selectedProvider?.provider === 'gitlab';
  const publicOrigin =
    typeof window === 'undefined'
      ? 'https://your-deployment-url'
      : window.location.origin;
  const gitlabRedirectUri = `${publicOrigin}/api/auth/oauth2/callback/gitlab`;
  const typedGitLabBaseUrl =
    values['GITLAB_BASE_URL']?.trim().replace(/\/+$/, '') ?? '';
  const configuredGitLabBaseUrl =
    sourceControlSetup.gitlabBaseUrl?.trim().replace(/\/+$/, '') ?? '';
  const effectiveGitLabBaseUrl = /^https?:\/\//.test(typedGitLabBaseUrl)
    ? typedGitLabBaseUrl
    : /^https?:\/\//.test(configuredGitLabBaseUrl)
      ? configuredGitLabBaseUrl
      : 'https://gitlab.com';
  const gitlabApplicationsUrl = `${effectiveGitLabBaseUrl}/-/user_settings/applications`;
  const valuesStepNumber = isGitLab ? 3 : 2;

  if (isGitHubManifestDefault) {
    return (
      <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
        <StepTitle text="Create GitHub App" />

        <div className="space-y-3 max-w-xl">
          <p>
            Because Roomote is self-hosted, we can&apos;t offer you an
            out-of-the-box GitHub app - you need to create your own.
          </p>
          <p>
            Roomote can create it for you automatically or you can enter values
            manually if you already have an app or want to do each step
            yourself.
          </p>
        </div>

        <div className="space-y-1 max-w-xl mt-6">
          <Label htmlFor="github-app-organization">
            GitHub organization (optional)
          </Label>
          <Input
            id="github-app-organization"
            value={githubOrganization}
            onChange={(event) => setGithubOrganization(event.target.value)}
            placeholder="your-organization"
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
            data-1p-ignore
          />
          <p className="text-sm text-muted-foreground">
            The app can only be installed on the account that owns it. Enter an
            organization name to create the app there, or leave this blank to
            create it on your personal GitHub account.
          </p>
        </div>

        {manifestForm ? (
          <form
            ref={manifestFormRef}
            action={manifestForm.postTarget}
            method="post"
            className="hidden"
            aria-hidden="true"
          >
            <input
              name="manifest"
              value={manifestForm.values.manifest}
              readOnly
            />
          </form>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
          {onBack ? (
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={createGitHubAppManifest.isPending}
            >
              <ArrowLeft />
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() =>
              createGitHubAppManifest.mutate({
                redirect: '/setup?step=source-control-connect',
                organization: githubOrganization.trim() || null,
              })
            }
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
          >
            {createGitHubAppManifest.isPending || manifestForm ? (
              <Spinner />
            ) : (
              <Sparkles />
            )}
            Create GitHub App
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowManualGitHubValues(true)}
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
          >
            <Pencil />
            Enter values manually
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-2xl space-y-4 py-2 md:py-0">
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
                <Button variant="outline" className="ml-2" asChild>
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
              <>Create a new {providerSetupLabel}.</>
            )}
          </p>
          {providerSetupCopy?.creationHint ? (
            <p className="text-sm text-muted-foreground">
              {providerSetupCopy.creationHint}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Optionally,{' '}
            <Link
              className="underline underline-offset-4 hover:text-foreground"
              href="/api/setup/roomote-logo"
            >
              download our logo
            </Link>{' '}
            to use as the app or bot account&apos;s avatar so Roomote&apos;s
            activity is easy to recognize.
          </p>
        </div>
      </div>

      {isGitLab ? (
        <div className="flex gap-2 items-start">
          <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0 mt-1">
            2
          </span>
          <div>
            <p className="font-semibold">
              Recommended: create a GitLab OAuth application.
              <Button variant="outline" className="ml-2" asChild>
                <a
                  href={gitlabApplicationsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Go <ExternalLink className="inline size-4 -mt-1 ml-1" />
                </a>
              </Button>
            </p>
            <p className="text-sm text-muted-foreground">
              Teammates can trigger Roomote from merge request comments only
              after linking their GitLab account, and that linking flow needs an
              OAuth application. Create one on the bot account (or as a group or
              instance-wide application), mark it confidential, select the{' '}
              <code>read_user</code> scope, and use this redirect URI:
            </p>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <code className="break-all text-foreground">
                {gitlabRedirectUri}
              </code>
              <CopyIconButton
                content={gitlabRedirectUri}
                tooltip="Copy redirect URI"
              />
            </p>
            <p className="text-sm text-muted-foreground">
              Then paste the generated Application ID and Secret into the OAuth
              fields below.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex gap-2 items-start">
        <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
          {valuesStepNumber}
        </span>
        <p className="font-semibold">
          Enter the values below for your {provider ?? 'source control'}{' '}
          integration.
        </p>
      </div>

      <div className="space-y-2 pl-10">
        {selectedProvider?.fields.map((field) => {
          const value = values[field.envVarName] ?? '';
          const shouldShowSavedValueMask =
            !field.runtimeSatisfied &&
            field.savedSatisfied &&
            value.length === 0 &&
            !editingSavedValues[field.envVarName];

          return (
            <div
              key={field.envVarName}
              className="grid gap-2 md:grid-cols-[200px_minmax(0,1fr)] md:items-center max-w-xl"
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
                        ? ''
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
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.envVarName]: event.target.value,
                      }))
                    }
                    placeholder={field.runtimeSatisfied ? '' : field.envVarName}
                    disabled={
                      saveSourceControlConfig.isPending ||
                      field.runtimeSatisfied
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
          <EnvVarsInfoNote />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mt-8">
        {onBack ? (
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={saveSourceControlConfig.isPending}
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
          {saveSourceControlConfig.isPending
            ? 'Saving...'
            : canContinueWithoutNewValues
              ? 'Continue'
              : 'Save and continue'}
          {saveSourceControlConfig.isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </div>
    </div>
  );
}

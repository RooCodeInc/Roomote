'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Button,
  ExternalLink,
  Input,
  Label,
  Pencil,
  Sparkles,
  Spinner,
} from '@/components/system';
import { useCreateGitHubAppManifest } from '@/hooks/github';

export function GitHubSourceControlConfig({
  onBack,
  onManualValues,
  managedConnectionUrl,
  onManagedContinue,
}: {
  onBack?: () => void;
  onManualValues: () => void;
  managedConnectionUrl?: string | null;
  onManagedContinue?: () => void;
}) {
  const [githubOrganization, setGithubOrganization] = useState('');
  const [manifestForm, setManifestForm] = useState<{
    postTarget: string;
    values: { manifest: string };
  } | null>(null);
  const manifestFormRef = useRef<HTMLFormElement | null>(null);
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
    if (manifestForm) {
      manifestFormRef.current?.submit();
    }
  }, [manifestForm]);

  if (managedConnectionUrl) {
    return (
      <>
        <div className="max-w-xl space-y-3">
          <p>
            Your deployment includes the shared Roomote Cloud GitHub App. Open
            Roomote Cloud to choose the GitHub organization and repositories
            this Roomote instance can access.
          </p>
          <p className="text-sm text-muted-foreground">
            You won&apos;t need to create an app, copy credentials, or configure
            a webhook.
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:items-center">
          {onBack ? (
            <Button type="button" variant="outline" onClick={onBack}>
              <ArrowLeft />
              Back
            </Button>
          ) : null}
          <Button asChild>
            <a
              href={managedConnectionUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Roomote Cloud
              <ExternalLink />
            </a>
          </Button>
          {onManagedContinue ? (
            <Button type="button" onClick={onManagedContinue} variant="outline">
              Continue after connecting
            </Button>
          ) : null}
        </div>

        <button
          type="button"
          className="mt-4 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={onManualValues}
        >
          Use my own GitHub App instead
        </button>
      </>
    );
  }

  return (
    <>
      <div className="space-y-3 max-w-xl">
        <p>
          Because Roomote is self-hosted, we can&apos;t offer you an out-of-the-
          box GitHub app - you need to create your own.
        </p>
        <p>
          Roomote can create it for you automatically or you can enter values
          manually if you already have an app or want to do each step yourself.
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
          disabled={createGitHubAppManifest.isPending || manifestForm !== null}
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
          disabled={createGitHubAppManifest.isPending || manifestForm !== null}
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
          onClick={onManualValues}
          disabled={createGitHubAppManifest.isPending || manifestForm !== null}
        >
          <Pencil />
          Enter values manually
        </Button>
      </div>
    </>
  );
}

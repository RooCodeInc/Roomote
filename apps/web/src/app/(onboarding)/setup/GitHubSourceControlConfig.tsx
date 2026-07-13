'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Button,
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
}: {
  onBack?: () => void;
  onManualValues: () => void;
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

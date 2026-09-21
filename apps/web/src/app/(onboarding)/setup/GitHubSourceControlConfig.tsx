'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Sparkles,
  Spinner,
} from '@/components/system';
import { useCreateGitHubAppManifest } from '@/hooks/github';

export function GitHubSourceControlConfig({
  onBack,
  returnPath = '/setup?step=source-control-connect',
}: {
  onBack?: () => void;
  returnPath?: string;
}) {
  const [appOwner, setAppOwner] = useState<'personal' | 'organization'>(
    'personal',
  );
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
          Because Roomote is self-hosted, we can&apos;t offer you an
          out-of-the-box GitHub app - you need to create your own.
        </p>
        <p>But it&apos;s super easy.</p>
      </div>

      <div className="space-y-3 max-w-xl mt-6">
        <div className="space-y-2">
          <Label>GitHub App owner</Label>
          <RadioGroup
            aria-label="GitHub App owner"
            value={appOwner}
            onValueChange={(value) => {
              const nextOwner = value as 'personal' | 'organization';
              setAppOwner(nextOwner);
              if (nextOwner === 'personal') {
                setGithubOrganization('');
              }
            }}
            disabled={
              createGitHubAppManifest.isPending || manifestForm !== null
            }
            className="flex flex-col gap-2 sm:flex-row sm:gap-6"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="personal" id="github-app-owner-personal" />
              <Label htmlFor="github-app-owner-personal">
                Personal account
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="organization"
                id="github-app-owner-organization"
              />
              <Label htmlFor="github-app-owner-organization">
                Organization
              </Label>
            </div>
          </RadioGroup>
        </div>
        {appOwner === 'organization' ? (
          <div className="space-y-2">
            <Label htmlFor="github-app-organization">
              GitHub organization slug
            </Label>
            <Input
              id="github-app-organization"
              className="font-mono"
              value={githubOrganization}
              onChange={(event) => setGithubOrganization(event.target.value)}
              placeholder="your-organization"
              required
              disabled={
                createGitHubAppManifest.isPending || manifestForm !== null
              }
              data-1p-ignore
            />
            <p className="text-sm text-muted-foreground">
              The GitHub organization that should own this app.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The app will be created on your personal GitHub account and can be
            installed on organizations you belong to.
          </p>
        )}
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
              redirect: returnPath,
              organization:
                appOwner === 'organization' ? githubOrganization.trim() : null,
            })
          }
          disabled={
            createGitHubAppManifest.isPending ||
            manifestForm !== null ||
            (appOwner === 'organization' && !githubOrganization.trim())
          }
        >
          {createGitHubAppManifest.isPending || manifestForm ? (
            <Spinner />
          ) : (
            <Sparkles />
          )}
          Create GitHub App
        </Button>
      </div>
    </>
  );
}

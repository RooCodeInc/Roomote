'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Button,
  Input,
  Label,
  Sparkles,
  Spinner,
} from '@/components/system';
import { useCreateGitHubAppManifest } from '@/hooks/github';

export function GitHubSourceControlConfig({ onBack }: { onBack?: () => void }) {
  const [githubOrganization, setGithubOrganization] = useState('');
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
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

      <div className="space-y-2 max-w-xl mt-6">
        <div>
          <button
            type="button"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
            onClick={() => setShowAdvancedConfig((current) => !current)}
          >
            {showAdvancedConfig
              ? 'Hide advanced config'
              : 'Show advanced config'}
          </button>
        </div>
        {showAdvancedConfig ? (
          <>
            <div className="grid gap-2 md:grid-cols-[200px_minmax(0,1fr)] md:items-center max-w-xl">
              <Label htmlFor="github-app-organization">
                GitHub organization
              </Label>
              <Input
                id="github-app-organization"
                className="font-mono"
                value={githubOrganization}
                onChange={(event) => setGithubOrganization(event.target.value)}
                placeholder="your-organization"
                disabled={
                  createGitHubAppManifest.isPending || manifestForm !== null
                }
                data-1p-ignore
              />
            </div>
            <p className="text-sm text-muted-foreground">
              By default the app is created on your personal GitHub account and
              can be installed on any organization you belong to. Enter an
              organization name if the organization should own the app instead.
            </p>
          </>
        ) : null}
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
      </div>
    </>
  );
}

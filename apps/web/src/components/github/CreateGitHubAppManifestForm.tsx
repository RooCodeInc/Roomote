'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useCreateGitHubAppManifest } from '@/hooks/github';
import { Button, Input, Label, Sparkles, Spinner } from '@/components/system';
import { cn } from '@/lib/utils';

type ManifestFormState = {
  postTarget: string;
  values: {
    manifest: string;
  };
};

type CreateGitHubAppManifestFormProps = {
  redirect: string;
  organizationInputId?: string;
  title?: ReactNode;
  description?: ReactNode;
  createButtonSize?: 'default' | 'sm';
  className?: string;
  leadingActions?: ReactNode | ((context: { isBusy: boolean }) => ReactNode);
  trailingActions?: ReactNode | ((context: { isBusy: boolean }) => ReactNode);
  actionsClassName?: string;
  organizationFieldClassName?: string;
};

export function CreateGitHubAppManifestForm({
  redirect,
  organizationInputId = 'github-app-organization',
  title,
  description,
  createButtonSize = 'default',
  className,
  leadingActions,
  trailingActions,
  actionsClassName = 'flex flex-col gap-2 sm:flex-row sm:items-center',
  organizationFieldClassName = 'space-y-1',
}: CreateGitHubAppManifestFormProps) {
  const [githubOrganization, setGithubOrganization] = useState('');
  const [manifestForm, setManifestForm] = useState<ManifestFormState | null>(
    null,
  );
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
  const isBusy = createGitHubAppManifest.isPending || manifestForm !== null;

  useEffect(() => {
    if (manifestForm) {
      manifestFormRef.current?.submit();
    }
  }, [manifestForm]);

  return (
    <div className={cn('space-y-4', className)}>
      {title || description ? (
        <div className="space-y-2">
          {title}
          {description}
        </div>
      ) : null}

      <div className={organizationFieldClassName}>
        <Label htmlFor={organizationInputId}>
          GitHub organization (optional)
        </Label>
        <Input
          id={organizationInputId}
          value={githubOrganization}
          onChange={(event) => setGithubOrganization(event.target.value)}
          placeholder="your-organization"
          disabled={isBusy}
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

      <div className={actionsClassName}>
        {typeof leadingActions === 'function'
          ? leadingActions({ isBusy })
          : leadingActions}
        <Button
          type="button"
          size={createButtonSize}
          onClick={() =>
            createGitHubAppManifest.mutate({
              redirect,
              organization: githubOrganization.trim() || null,
            })
          }
          disabled={isBusy}
        >
          {isBusy ? <Spinner /> : <Sparkles />}
          Create GitHub App
        </Button>
        {typeof trailingActions === 'function'
          ? trailingActions({ isBusy })
          : trailingActions}
      </div>
    </div>
  );
}

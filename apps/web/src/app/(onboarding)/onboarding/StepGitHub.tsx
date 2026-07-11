'use client';

import { toast } from 'sonner';
import { getGitHubAppMention, PRODUCT_NAME } from '@roomote/types';

import { useAuthenticateGitHubAccount } from '@/hooks/github';

import { Button, Github, Spinner } from '@/components/system';

import { StepCompletedBadge } from '../setup/StepCompletedBadge';
import { StepTitle } from '../setup/StepTitle';

export function StepGitHub({
  githubAppSlug,
  onContinue,
  previousStepCompleted,
}: {
  githubAppSlug: string;
  onContinue: () => void;
  previousStepCompleted?: string;
}) {
  const githubAppMention = getGitHubAppMention(githubAppSlug);
  const authenticateGitHubAccount = useAuthenticateGitHubAccount({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () =>
      toast.error('Failed to link GitHub account. Please try again.'),
  });

  return (
    <div className="space-y-6 max-w-md relative">
      {previousStepCompleted && (
        <StepCompletedBadge text={previousStepCompleted} />
      )}
      <StepTitle text="Link GitHub Profile" showCheckbox={false} />
      <p className="text-muted-foreground">
        {PRODUCT_NAME} PRs and comments are published by the{' '}
        <strong>{githubAppMention}</strong> GitHub app by default.
      </p>
      <p className="text-muted-foreground">
        If you want credit for your work by having PRs and comments posted as
        you, connect your account.
      </p>
      <div className="flex items-center gap-3">
        <Button
          onClick={() =>
            authenticateGitHubAccount.mutate(
              '/onboarding?step=github&github=connected',
            )
          }
          disabled={authenticateGitHubAccount.isPending}
        >
          {authenticateGitHubAccount.isPending ? <Spinner /> : <Github />}
          Link GitHub Profile
        </Button>
      </div>
      <button
        className="cursor-pointer text-sm text-muted-foreground underline"
        onClick={onContinue}
      >
        Do this later
      </button>
    </div>
  );
}

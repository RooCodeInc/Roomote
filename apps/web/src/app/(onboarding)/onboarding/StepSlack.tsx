'use client';

import { toast } from 'sonner';

import { useAuthenticateSlackAccount } from '@/hooks/slack';

import { Button, Slack, Spinner } from '@/components/system';

import { StepCompletedBadge } from '../setup/StepCompletedBadge';
import { StepTitle } from '../setup/StepTitle';

export function StepSlack({
  onContinue,
  previousStepCompleted,
}: {
  onContinue: () => void;
  previousStepCompleted?: string;
}) {
  const authenticateSlackAccount = useAuthenticateSlackAccount({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () =>
      toast.error('Failed to link Slack account. Please try again.'),
  });

  return (
    <div className="space-y-6 max-w-md relative">
      {previousStepCompleted && (
        <StepCompletedBadge text={previousStepCompleted} />
      )}
      <StepTitle text="Link Slack" showCheckbox={false} />
      <p className="text-muted-foreground">
        To ask questions and get agents working directly from Slack, link your
        account.
      </p>
      <div className="flex items-center gap-3">
        <Button
          onClick={() =>
            authenticateSlackAccount.mutate('/onboarding?step=slack')
          }
          disabled={authenticateSlackAccount.isPending}
        >
          {authenticateSlackAccount.isPending ? <Spinner /> : <Slack />}
          Link Slack Profile
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

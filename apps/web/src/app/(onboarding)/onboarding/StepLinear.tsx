'use client';

import { toast } from 'sonner';

import { useAuthenticateLinearAccount } from '@/hooks/linear/useAuthenticateLinearAccount';

import { Button, LinearLogo, Spinner } from '@/components/system';

import { StepCompletedBadge } from '../setup/StepCompletedBadge';
import { StepTitle } from '../setup/StepTitle';

export function StepLinear({
  onContinue,
  previousStepCompleted,
}: {
  onContinue: () => void;
  previousStepCompleted?: string;
}) {
  const authenticateLinear = useAuthenticateLinearAccount();

  return (
    <div className="space-y-6 max-w-md relative">
      {previousStepCompleted && (
        <StepCompletedBadge text={previousStepCompleted} />
      )}
      <StepTitle text="Link Linear" showCheckbox={false} />
      <p className="text-muted-foreground">
        To assign tasks to agents and chill while you watch them work, link your
        account.
      </p>
      <div className="flex items-center gap-3">
        <Button
          onClick={() =>
            authenticateLinear.mutate('/onboarding?step=linear', {
              onError: () =>
                toast.error('Failed to link Linear account. Please try again.'),
            })
          }
          disabled={authenticateLinear.isPending}
        >
          {authenticateLinear.isPending ? (
            <Spinner />
          ) : (
            <LinearLogo className="size-4" />
          )}
          Link Linear Profile
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

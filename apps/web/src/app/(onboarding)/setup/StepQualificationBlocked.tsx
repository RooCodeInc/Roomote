'use client';

import { toast } from 'sonner';
import { PRODUCT_NAME } from '@roomote/types';

import { useCreateGitHubInstallation } from '@/hooks/github/useCreateGitHubInstallation';
import { ArrowLeft, Button, Spinner } from '@/components/system';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const QUALIFICATION_BLOCKED_STEP = getSetupStepDefinition(
  'qualification-blocked',
);

export function StepQualificationBlocked() {
  const createInstallation = useCreateGitHubInstallation({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () => toast.error('Failed to connect GitHub. Please try again.'),
  });

  return (
    <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
      <StepTitle text={QUALIFICATION_BLOCKED_STEP.title} />
      <p className="font-semibold">
        We&apos;re sorry, but we can&apos;t proceed with your setup right now.
      </p>
      <p className="font-semibold">
        Since we&apos;re building {PRODUCT_NAME} for teams with chores to
        handle, setup is currently limited to GitHub installs that belong to an
        organization account. The one you just connected to looks like a
        personal account.
      </p>
      <p>
        We&apos;ll email you when we open up more broadly. If we got it wrong,
        use the chat in the bottom right and let someone from the team know.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          variant="outline"
          type="button"
          onClick={() =>
            createInstallation.mutate(
              `${window.location.pathname}?step=qualification-blocked`,
            )
          }
          disabled={createInstallation.isPending}
        >
          {createInstallation.isPending ? <Spinner /> : <ArrowLeft />}
          Use another GitHub account
        </Button>
      </div>
    </div>
  );
}

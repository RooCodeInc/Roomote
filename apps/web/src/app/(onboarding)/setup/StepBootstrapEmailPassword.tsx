'use client';

import { EmailPasswordAuth } from '@/app/(unauthenticated)/email-password-auth';
import { ArrowLeft, Button } from '@/components/system';

import { StepTitle } from './StepTitle';

export function StepBootstrapEmailPassword({ onBack }: { onBack: () => void }) {
  return (
    <div className="relative w-full max-w-sm space-y-6 py-2 md:py-0">
      <StepTitle text="Create your account" />
      <p>This is how you&apos;ll access this Roomote deployment.</p>
      <EmailPasswordAuth
        redirectUrl="/setup"
        defaultMode="sign-up"
        showModeToggle={false}
        labelsAsPlaceholders={true}
        hideModeSwitchMessage={true}
        showNameField={false}
        submitButtonClassName="w-auto"
        submitLeadingAction={
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
        }
      />
    </div>
  );
}

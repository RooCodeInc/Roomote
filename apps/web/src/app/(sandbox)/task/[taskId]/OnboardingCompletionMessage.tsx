import Link from 'next/link';

import { ArrowRight, Button } from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';
import {
  environmentVerificationDisplay,
  getEnvironmentVerificationState,
  type EnvironmentVerificationState,
} from '@/components/settings/environments/EnvironmentVerificationStatus';

export function OnboardingCompletionMessage({
  environment,
}: {
  environment: {
    name: string;
    isVerified: boolean;
    verificationTaskId: string | null;
    verificationTaskActive: boolean;
    verificationError: string | null;
  };
}) {
  const state = getEnvironmentVerificationState(environment);
  const { Icon, iconClassName } = environmentVerificationDisplay[state];
  const copy = getOnboardingCompletionCopy(state, environment.name);

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex flex-wrap items-start gap-2 text-sm bg-card px-4 pt-2 pb-4 rounded-lg max-w-xl">
          <Icon
            className={['size-4 shrink-0 mt-2.5', iconClassName]
              .filter(Boolean)
              .join(' ')}
          />
          <div>
            <p className="font-medium">{copy.title}</p>
            <p>{copy.body}</p>
            <div className="flex gap-2 items-center">
              <Button asChild size="sm">
                <Link href="/">
                  Go
                  <ArrowRight />
                </Link>
              </Button>
              {(state === 'failed' || state === 'configured') && (
                <Button asChild size="sm" variant="outline">
                  <Link href="/settings/environments">View env settings</Link>
                </Button>
              )}
            </div>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function getOnboardingCompletionCopy(
  state: EnvironmentVerificationState,
  environmentName: string,
) {
  switch (state) {
    case 'verified':
      return {
        title: `The ${environmentName} environment is set up and verified.`,
        body: 'You can start your first task now.',
      };
    case 'in_progress':
      return {
        title: `The ${environmentName} environment is set up.`,
        body: 'Roomote is still verifying it. You can start your first task now.',
      };
    case 'failed':
      return {
        title: `The ${environmentName} environment is set up, but verification failed.`,
        body: "You can start a task, but it's worth checking why verification failed.",
      };
    case 'configured':
    default:
      return {
        title: `The ${environmentName} environment is set up, but not verified yet.`,
        body: "You can start a task, but it's worth checking verification before relying on it.",
      };
  }
}

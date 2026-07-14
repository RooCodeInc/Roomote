'use client';

import type { SetupAuthStatus } from '@roomote/types';
import { toast } from 'sonner';

import { useConnectSlack } from '@/hooks/slack';
import { useTeamsIntegrationStatus } from '@/hooks/teams';
import { TaskStatusIndicator } from '@/components/sandbox';
import {
  ArrowRight,
  BrandIcon,
  Button,
  ExternalLink,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const COMMUNICATION_CONNECT_STEP = getSetupStepDefinition('slack');

function getCommunicationProvider(authSetup: SetupAuthStatus) {
  return (
    authSetup.selectedProvider ??
    authSetup.runtimeConfiguredProvider ??
    authSetup.preselectedProvider
  );
}

export function StepCommunicationConnect({
  authSetup,
  onContinue,
  onSkip,
  onBack,
  returnPath = '/setup?step=slack',
}: {
  authSetup: SetupAuthStatus;
  onContinue: () => void;
  onSkip: () => void;
  onBack?: () => void;
  returnPath?: string;
}) {
  const provider = getCommunicationProvider(authSetup);
  const connectSlack = useConnectSlack(returnPath, {
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: () => toast.error('Failed to connect Slack. Please try again.'),
  });
  const teamsIntegrationStatus = useTeamsIntegrationStatus();
  const skipLink = (
    <button
      type="button"
      className="cursor-pointer text-sm text-muted-foreground underline"
      onClick={onSkip}
    >
      Do this later
    </button>
  );
  const backLink = onBack ? (
    <button
      type="button"
      className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      onClick={onBack}
    >
      Back
    </button>
  ) : null;

  if (provider === 'microsoft') {
    const teamsStatus = teamsIntegrationStatus.data;
    const openInTeamsUrl = teamsStatus?.openInTeamsUrl ?? null;
    const teamsBotName = teamsStatus?.botName?.trim() || 'Roomote';
    const teamsReady =
      teamsStatus?.botConfigured === true &&
      teamsStatus.microsoftAuthConfigured &&
      openInTeamsUrl !== null;
    const primaryConversationReady = Boolean(
      teamsStatus?.primaryConversationReady,
    );

    return (
      <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
        <StepTitle text="Finish connecting Teams" />
        <p className="text-foreground">
          Almost there. Teams just needs you to send a message (just
          &quot;Hi!&quot; works) to Roomote to finish.
        </p>

        <div className="space-y-4">
          {teamsIntegrationStatus.isPending ? (
            <Spinner />
          ) : teamsIntegrationStatus.isError ? (
            <p className="text-sm text-destructive">
              Unable to load Microsoft Teams setup status. Refresh and try
              again.
            </p>
          ) : teamsReady ? (
            <>
              <div>
                <div className="flex items-center gap-2 font-semibold">
                  <TaskStatusIndicator
                    phase={
                      primaryConversationReady
                        ? 'waiting_for_prompt'
                        : 'stopped'
                    }
                    compact={true}
                  />
                  <span>
                    {primaryConversationReady
                      ? 'Received!'
                      : 'Waiting for bot message'}
                  </span>
                </div>
                <p className="pl-4 text-muted-foreground">
                  Send a message to the {teamsBotName} bot on Teams to complete
                  the connection
                </p>
              </div>
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <Button asChild variant="outline">
                  <a
                    href={openInTeamsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <BrandIcon
                      icon="teams"
                      name=""
                      className="size-4 shrink-0"
                    />
                    Open Microsoft Teams bot
                    <ExternalLink className="size-4 shrink-0" />
                  </a>
                </Button>
                <Button
                  type="button"
                  className="w-full sm:w-auto"
                  onClick={onContinue}
                  disabled={!primaryConversationReady}
                >
                  Continue
                  <ArrowRight />
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Microsoft Teams is not ready to open because the bot app ID is
              missing from this deployment.
            </p>
          )}
          <div className="flex flex-col items-start gap-2">
            {skipLink}
            {backLink}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
      <StepTitle text={COMMUNICATION_CONNECT_STEP.title} />
      <p className="text-foreground">
        This deployment is already configured for Slack. Connect the Slack app
        so Roomote can talk with your workspace.
      </p>
      <div className="flex flex-col items-stretch gap-3 sm:items-start">
        <Button
          className="w-full sm:w-auto"
          onClick={() => connectSlack.mutate()}
          disabled={connectSlack.isPending}
        >
          {connectSlack.isPending ? (
            <Spinner />
          ) : (
            <BrandIcon icon="slack" name="" className="size-4 shrink-0" />
          )}
          Connect to Slack
        </Button>
      </div>
      <div className="flex flex-col items-start gap-2">
        {skipLink}
        {backLink}
      </div>
    </div>
  );
}

'use client';

import type { SetupAuthStatus } from '@roomote/types';
import { toast } from 'sonner';

import { useConnectSlack } from '@/hooks/slack';
import { useTeamsIntegrationStatus } from '@/hooks/teams';
import { BrandIcon, Button, ExternalLink, Spinner } from '@/components/system';

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
  returnPath = '/setup?step=slack',
}: {
  authSetup: SetupAuthStatus;
  onContinue: () => void;
  onSkip: () => void;
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

  if (provider === 'microsoft') {
    const teamsStatus = teamsIntegrationStatus.data;
    const openInTeamsUrl = teamsStatus?.openInTeamsUrl ?? null;
    const teamsReady =
      teamsStatus?.botConfigured === true &&
      teamsStatus.microsoftAuthConfigured &&
      openInTeamsUrl !== null;
    const primaryConversationReady = Boolean(
      teamsStatus?.primaryConversationReady,
    );

    return (
      <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
        <StepTitle text="Connect Microsoft Teams" />
        <p className="text-foreground">
          This deployment is already configured for Microsoft Teams. Open the
          bot in Teams to finish connecting your workspace.
        </p>

        {teamsIntegrationStatus.isPending ? (
          <Spinner />
        ) : teamsIntegrationStatus.isError ? (
          <p className="text-sm text-destructive">
            Unable to load Microsoft Teams setup status. Refresh and try again.
          </p>
        ) : teamsReady ? (
          <>
            <p className="text-sm text-muted-foreground">
              Haven&apos;t added Roomote to Teams yet?{' '}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href="/api/teams/app-package"
                download
              >
                Download the app package
              </a>{' '}
              and upload it in Teams under Apps → Manage your apps → Upload an
              app.
            </p>
            {!primaryConversationReady ? (
              <p className="text-sm text-muted-foreground">
                Roomote has not received a Teams message yet. Open the bot and
                send it one message so Roomote can capture the conversation that
                setup and automation updates post into.
              </p>
            ) : null}
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Button asChild className="w-full sm:w-auto">
                <a
                  href={openInTeamsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BrandIcon icon="teams" name="" className="size-4 shrink-0" />
                  Open Microsoft Teams bot
                  <ExternalLink className="size-4 shrink-0" />
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={onContinue}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Microsoft Teams is not ready to open because the bot app ID is
            missing from this deployment.
          </p>
        )}
        {skipLink}
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
      {skipLink}
    </div>
  );
}

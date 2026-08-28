'use client';

import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SetupAuthStatus } from '@roomote/types';
import { toast } from 'sonner';

import { useConnectSlack } from '@/hooks/slack';
import { useTeamsIntegrationStatus } from '@/hooks/teams';
import { useTRPC } from '@/trpc/client';
import { TaskStatusIndicator } from '@/components/sandbox';
import {
  ArrowRight,
  BrandIcon,
  Button,
  ExternalLink,
  Spinner,
} from '@/components/system';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
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
  const trpc = useTRPC();
  const provider = getCommunicationProvider(authSetup);
  const connectSlack = useConnectSlack(returnPath, {
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: () => toast.error('Failed to connect Slack. Please try again.'),
  });
  const teamsIntegrationStatus = useTeamsIntegrationStatus();
  const configuredTrackedRef = useRef(false);
  const authedTrackedRef = useRef(false);
  const trackCommsState = useMutation(
    trpc.setupNew.trackCommsState.mutationOptions(),
  );
  const teamsStatus = teamsIntegrationStatus.data;
  const teamsConfigured =
    teamsStatus?.botConfigured === true && teamsStatus.microsoftAuthConfigured;
  const primaryConversationReady = Boolean(
    teamsStatus?.primaryConversationReady,
  );
  useEffect(() => {
    if (
      provider === 'microsoft' &&
      teamsConfigured &&
      !configuredTrackedRef.current
    ) {
      configuredTrackedRef.current = true;
      trackCommsState.mutate({
        provider: 'microsoft',
      });
    }
  }, [provider, teamsConfigured, trackCommsState]);
  useEffect(() => {
    if (
      provider === 'microsoft' &&
      primaryConversationReady &&
      !authedTrackedRef.current
    ) {
      authedTrackedRef.current = true;
      trackCommsState.mutate({
        provider: 'microsoft',
      });
    }
  }, [primaryConversationReady, provider, trackCommsState]);
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
    const openInTeamsUrl = teamsStatus?.openInTeamsUrl ?? null;
    const teamsBotName = teamsStatus?.botName?.trim() || 'Roomote';
    const teamsReady = teamsConfigured && openInTeamsUrl !== null;

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
              <SetupFooter onBack={onBack}>
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
                  onClick={onContinue}
                  disabled={!primaryConversationReady}
                >
                  Continue
                  <ArrowRight />
                </Button>
              </SetupFooter>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Microsoft Teams is not ready to open because the bot app ID is
              missing from this deployment.
            </p>
          )}
          <SetupFooter onBack={onBack}>{skipLink}</SetupFooter>
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
      <p className="text-sm text-muted-foreground">
        Roomote can read and reply in direct messages and channels where the app
        has been added. It can list public channels so you can choose
        destinations, but it cannot read or post in a private channel unless
        someone invites it.
      </p>
      <SetupFooter onBack={onBack}>
        <Button
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
        {skipLink}
      </SetupFooter>
    </div>
  );
}

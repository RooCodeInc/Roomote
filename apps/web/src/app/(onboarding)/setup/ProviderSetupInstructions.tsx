'use client';

import type { ReactNode } from 'react';
import type { SetupAuthProviderId } from '@roomote/types';

import { BasicTooltip, CopyIconButton } from '@/components/system';
import {
  SLACK_APP_INSTALL_CALLBACK_PATH,
  SLACK_SIGN_IN_CALLBACK_PATH,
} from '@/lib/slack-callback-paths';
import { cn } from '@/lib/utils';

type ProviderSetupInstructionsProviderId =
  | SetupAuthProviderId
  | 'telegram'
  | 'discord';

function InstructionText({
  heading,
  children,
}: {
  heading?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="font-semibold text-foreground">{heading}</p>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function InstructionUrl({ heading, url }: { heading: string; url: string }) {
  return (
    <div className="space-y-1 flex gap-2 items-center">
      <p className="font-semibold text-foreground text-sm w-45 shrink-0">
        {heading}
      </p>
      <div className="flex items-center gap-2 rounded-md border border-black px-2 py-1.5 overflow-hidden justify-end">
        <BasicTooltip content={url}>
          <span className="font-mono text-xs text-foreground truncate">
            {url}
          </span>
        </BasicTooltip>
        <CopyIconButton
          aria-label={`Copy ${heading}`}
          content={url}
          tooltip={`Copy ${heading}`}
        />
      </div>
    </div>
  );
}

export function ProviderSetupInstructions({
  providerId,
  publicOrigin,
  surface = 'settings',
  className,
}: {
  providerId: ProviderSetupInstructionsProviderId;
  publicOrigin: string;
  surface?: 'setup' | 'settings';
  className?: string;
}) {
  if (providerId === 'slack') {
    return (
      <div className={cn('space-y-3 max-w-xl', className)}>
        <InstructionText heading="Authorized redirect URLs">
          Register these as authorized redirect URLs (under OAuth &
          Permissions):
        </InstructionText>
        <InstructionUrl
          heading="Sign-in callback"
          url={`${publicOrigin}${SLACK_SIGN_IN_CALLBACK_PATH}`}
        />
        <InstructionUrl
          heading="App install callback"
          url={`${publicOrigin}${SLACK_APP_INSTALL_CALLBACK_PATH}`}
        />
      </div>
    );
  }

  if (providerId === 'microsoft') {
    const webRedirectUri = `${publicOrigin}/api/auth/oauth2/callback/microsoft-entra-id`;
    const teamsWebhookUrl = `${publicOrigin}/api/webhooks/teams`;

    if (surface === 'setup') {
      return (
        <div className={cn('space-y-3 max-w-xl', className)}>
          <InstructionText heading="Microsoft Entra Authentication">
            Under Authentication in Microsoft Entra, add:
          </InstructionText>
          <InstructionUrl heading="Web redirect URI" url={webRedirectUri} />
          <InstructionText>
            In the Teams Developer Portal, create a bot for this app with this
            messaging endpoint:
          </InstructionText>
          <InstructionUrl heading="Messaging endpoint" url={teamsWebhookUrl} />
        </div>
      );
    }

    return (
      <div className={cn('space-y-3 max-w-xl', className)}>
        <InstructionText heading="Microsoft Entra app">
          These values are for the Microsoft Entra app Roomote uses for Teams —
          both user sign-in and the bot. Under Authentication, add a Web
          redirect URI:
        </InstructionText>
        <InstructionUrl heading="Web redirect URI" url={webRedirectUri} />
        <InstructionText heading="Client secret">
          Create a client secret, then enter the Application (client) ID, the
          secret value, and the Directory (tenant) ID below.
        </InstructionText>
        <InstructionText heading="Teams Developer Portal">
          Create a bot for the same app in the Teams Developer Portal (Tools →
          Bot management) with the messaging endpoint
        </InstructionText>
        <InstructionUrl heading="Messaging endpoint" url={teamsWebhookUrl} />
        <InstructionText heading="Teams app package">
          then download the app package below and upload it in Teams. Dedicated
          R_TEAMS_BOT_* env vars override these values for the bot.
        </InstructionText>
      </div>
    );
  }

  if (providerId === 'telegram') {
    return (
      <div className={cn('space-y-3 max-w-xl', className)}>
        <InstructionText heading="Create bot">
          In the BotFather chat, send /newbot, pick a display name, then a
          username ending in &quot;bot&quot;.
        </InstructionText>
        <InstructionText heading="Bot token">
          Copy the bot token BotFather replies with into the field below.
        </InstructionText>
        <InstructionText heading="Threaded Mode">
          In BotFather, open Bot Settings → Threaded Mode and turn it on. This
          lets Roomote create a separate private-chat topic for every task.
          Telegram withholds a 15% fee from Stars purchases while this mode is
          enabled.
        </InstructionText>
      </div>
    );
  }

  if (providerId === 'discord') {
    return (
      <div className={cn('space-y-3 max-w-xl', className)}>
        <InstructionText heading="Create bot">
          Create an application in the Discord Developer Portal. Open its Bot
          page, add a bot, then reset and copy its token.
        </InstructionText>
        <InstructionText heading="Message Content intent">
          On the Bot page, enable Message Content Intent under Privileged
          Gateway Intents. Roomote needs it to understand ordinary messages and
          follow-ups in task threads.
        </InstructionText>
        <InstructionText heading="Bot token">
          Paste the token below. Roomote derives the bot and application names
          from it, so there is no separate name or application ID to enter.
        </InstructionText>
      </div>
    );
  }

  return null;
}

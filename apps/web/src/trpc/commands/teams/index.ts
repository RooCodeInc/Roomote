import {
  resolveTeamsBotRuntimeCredentials,
  resolveTeamsInvocationBotName,
} from '@roomote/db/server';
import { findTeamsPrimaryConversation } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';

import {
  checkTeamsBotCredentials,
  type TeamsBotCredentialCheck,
} from './bot-credential-check';

type TeamsIntegrationStatus = {
  botConfigured: boolean;
  /**
   * Whether the configured credentials actually authenticate with Microsoft.
   * `botConfigured` only reports that values are present, which cannot
   * distinguish a typo or an expired secret from a working bot.
   */
  botCredentialCheck: TeamsBotCredentialCheck;
  botUsesTenantSpecificTokenFlow: boolean;
  botUsesMicrosoftAuthFallback: boolean;
  microsoftAuthConfigured: boolean;
  webhookUrl: string;
  openInTeamsUrl: string | null;
  botName: string;
  /**
   * True when a verified inbound Teams activity has captured a conversation
   * Roomote can post back into. Without it, proactive Teams output (setup
   * onboarding kickoff, automation summaries) cannot reach Teams even when
   * the bot credentials are configured.
   */
  primaryConversationReady: boolean;
  primaryConversationType: string | null;
};

function getTeamsWebhookUrl() {
  return new URL(
    '/api/webhooks/teams',
    Env.R_PUBLIC_URL ?? Env.R_APP_URL,
  ).toString();
}

function getOpenInTeamsUrl(botAppId: string | null) {
  if (!botAppId) {
    return null;
  }

  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(`28:${botAppId}`)}`;
}

export async function getTeamsIntegrationStatusCommand(
  auth: UserAuthSuccess,
): Promise<TeamsIntegrationStatus> {
  void auth;

  const credentials = await resolveTeamsBotRuntimeCredentials();
  const [authProviderConfig, primaryConversation, botName, botCredentialCheck] =
    await Promise.all([
      resolveAuthProviderConfig(),
      findTeamsPrimaryConversation(),
      resolveTeamsInvocationBotName(),
      checkTeamsBotCredentials(credentials),
    ]);

  return {
    botConfigured: Boolean(credentials.botAppId && credentials.botAppPassword),
    botCredentialCheck,
    botUsesTenantSpecificTokenFlow: Boolean(credentials.botTenantId),
    botUsesMicrosoftAuthFallback: false,
    microsoftAuthConfigured: Boolean(
      authProviderConfig.microsoftClientId &&
      authProviderConfig.microsoftClientSecret &&
      authProviderConfig.microsoftTenantId,
    ),
    webhookUrl: getTeamsWebhookUrl(),
    openInTeamsUrl: getOpenInTeamsUrl(credentials.botAppId),
    botName,
    primaryConversationReady: primaryConversation !== null,
    primaryConversationType: primaryConversation?.conversationType ?? null,
  };
}

import { resolveTeamsBotRuntimeCredentials } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';

type TeamsIntegrationStatus = {
  botConfigured: boolean;
  botUsesTenantSpecificTokenFlow: boolean;
  botUsesMicrosoftAuthFallback: boolean;
  microsoftAuthConfigured: boolean;
  webhookUrl: string;
  openInTeamsUrl: string | null;
};

function getTeamsWebhookUrl() {
  return new URL(
    '/api/webhooks/teams',
    Env.ROOMOTE_PUBLIC_URL ?? Env.ROOMOTE_APP_URL,
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

  const [credentials, authProviderConfig] = await Promise.all([
    resolveTeamsBotRuntimeCredentials(),
    resolveAuthProviderConfig(),
  ]);

  return {
    botConfigured: Boolean(credentials.botAppId && credentials.botAppPassword),
    botUsesTenantSpecificTokenFlow: Boolean(credentials.botTenantId),
    botUsesMicrosoftAuthFallback: credentials.source === 'microsoft_auth',
    microsoftAuthConfigured: Boolean(
      authProviderConfig.microsoftClientId &&
      authProviderConfig.microsoftClientSecret &&
      authProviderConfig.microsoftTenantId,
    ),
    webhookUrl: getTeamsWebhookUrl(),
    openInTeamsUrl: getOpenInTeamsUrl(credentials.botAppId),
  };
}

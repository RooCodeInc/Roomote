import {
  db,
  users,
  slackInstallations,
  githubInstallations,
  githubUserMappings,
  slackUserMappings,
  deploymentMcpEnablements,
  mcpConnections,
  eq,
  and,
  inArray,
  isNull,
  or,
} from '@roomote/db/server';
import { resolveConfiguredGitHubAppSlug } from '@roomote/github';
import {
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';
import {
  LINEAR_ORG_CONNECTION_ROLE,
  LINEAR_USER_CONNECTION_ROLE,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { subscribeToProductUpdates } from '@/lib/server/product-updates';
import type { OnboardingLinkableProvider } from '@/app/(onboarding)/onboarding/types';
import {
  getLinkedAdoAccountCommand,
  getLinkedBitbucketAccountCommand,
  getLinkedDiscordAccountCommand,
  getLinkedGitLabAccountCommand,
  getLinkedGiteaAccountCommand,
  getLinkedMicrosoftTeamsAccountCommand,
  getLinkedTelegramAccountCommand,
} from '../linked-accounts';

export async function getOnboardingStatusCommand(auth: UserAuthSuccess) {
  const { userId } = auth;
  const mcpIntegrationIds = MCP_INTEGRATIONS.map(
    (integration) => integration.id,
  );

  const [
    userResult,
    slackInstallationResult,
    linearInstallationResult,
    githubLinkedResult,
    slackLinkedResult,
    linearLinkedResult,
    enabledUserLevelMcpResult,
    githubInstallationResult,
    gitlabAccount,
    giteaAccount,
    bitbucketAccount,
    adoAccount,
    microsoftTeamsAccount,
    telegramAccount,
    discordAccount,
    // The GitHub step renders the deployment's bot handle; resolve it through
    // the deployment env layer so a slug configured only in the database (the
    // /setup manifest flow) is shown instead of the hosted-product default.
    githubAppSlug,
  ] = await Promise.all([
    db
      .select({
        onboardingCompletedAt: users.onboardingCompletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db.select({ id: slackInstallations.id }).from(slackInstallations).limit(1),
    db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.mcpId, 'linear'),
          eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
          eq(mcpConnections.authStatus, 'authenticated'),
          isNull(mcpConnections.userId),
        ),
      )
      .limit(1),
    db
      .select({ id: githubUserMappings.id })
      .from(githubUserMappings)
      .where(eq(githubUserMappings.userId, userId))
      .limit(1),
    db
      .select({ id: slackUserMappings.id })
      .from(slackUserMappings)
      .where(eq(slackUserMappings.userId, userId))
      .limit(1),
    db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.userId, userId),
          eq(mcpConnections.mcpId, 'linear'),
          eq(mcpConnections.connectionRole, LINEAR_USER_CONNECTION_ROLE),
          eq(mcpConnections.authStatus, 'authenticated'),
        ),
      )
      .limit(1),
    mcpIntegrationIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ mcpId: deploymentMcpEnablements.mcpId })
          .from(deploymentMcpEnablements)
          .where(
            and(
              eq(deploymentMcpEnablements.enabled, true),
              inArray(deploymentMcpEnablements.mcpId, mcpIntegrationIds),
            ),
          ),
    db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(isNull(githubInstallations.suspendedAt))
      .limit(1),
    getLinkedGitLabAccountCommand(auth),
    getLinkedGiteaAccountCommand(auth),
    getLinkedBitbucketAccountCommand(auth),
    getLinkedAdoAccountCommand(auth),
    getLinkedMicrosoftTeamsAccountCommand(auth),
    getLinkedTelegramAccountCommand(auth),
    getLinkedDiscordAccountCommand(auth),
    resolveConfiguredGitHubAppSlug(),
  ]);

  const enabledUserLevelMcpIds = enabledUserLevelMcpResult.map(
    (enablement) => enablement.mcpId,
  );
  const enabledDeploymentScopedMcpIds = enabledUserLevelMcpIds.filter((mcpId) =>
    isDeploymentScopedMcpIntegration(mcpId),
  );
  const enabledUserScopedMcpIds = enabledUserLevelMcpIds.filter(
    (mcpId) => !isDeploymentScopedMcpIntegration(mcpId),
  );

  const linkableProviders: OnboardingLinkableProvider[] = [
    {
      id: 'slack',
      category: 'communication',
      label: 'Slack',
      configured: slackInstallationResult.length > 0,
      linked: slackLinkedResult.length > 0,
    },
    {
      id: 'microsoft',
      category: 'communication',
      label: 'Microsoft Teams',
      configured: microsoftTeamsAccount.configured,
      linked: microsoftTeamsAccount.account !== null,
    },
    {
      id: 'telegram',
      category: 'communication',
      label: 'Telegram',
      configured: telegramAccount.configured,
      linked: telegramAccount.mapping !== null,
    },
    {
      id: 'discord',
      category: 'communication',
      label: 'Discord',
      configured: discordAccount.configured,
      linked: discordAccount.mapping !== null,
    },
    {
      id: 'github',
      category: 'source-control',
      label: 'GitHub',
      configured: githubInstallationResult.length > 0,
      linked: githubLinkedResult.length > 0,
    },
    {
      id: 'gitlab',
      category: 'source-control',
      label: 'GitLab',
      configured: gitlabAccount.configured,
      linked: gitlabAccount.account !== null,
    },
    {
      id: 'gitea',
      category: 'source-control',
      label: 'Gitea',
      configured: giteaAccount.configured,
      linked: giteaAccount.account !== null,
    },
    {
      id: 'bitbucket',
      category: 'source-control',
      label: 'Bitbucket Cloud',
      configured: bitbucketAccount.configured,
      linked: bitbucketAccount.account !== null,
    },
    {
      id: 'ado',
      category: 'source-control',
      label: 'Azure DevOps',
      configured: adoAccount.configured,
      linked: adoAccount.account !== null,
    },
  ];

  const userConnectedEnabledMcpResult =
    enabledUserLevelMcpIds.length === 0
      ? []
      : await db
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(
            and(
              eq(mcpConnections.authStatus, 'authenticated'),
              or(
                ...(enabledUserScopedMcpIds.length > 0
                  ? [
                      and(
                        eq(mcpConnections.userId, userId),
                        inArray(mcpConnections.mcpId, enabledUserScopedMcpIds),
                      ),
                    ]
                  : []),
                ...(enabledDeploymentScopedMcpIds.length > 0
                  ? [
                      and(
                        isNull(mcpConnections.userId),
                        inArray(
                          mcpConnections.mcpId,
                          enabledDeploymentScopedMcpIds,
                        ),
                      ),
                    ]
                  : []),
              ),
            ),
          )
          .limit(1);

  return {
    onboardingCompletedAt: userResult[0]?.onboardingCompletedAt ?? null,
    isAdmin: auth.isAdmin,
    orgHasSlack: slackInstallationResult.length > 0,
    orgHasLinear: linearInstallationResult.length > 0,
    userHasLinkedGitHub: githubLinkedResult.length > 0,
    userHasLinkedSlack: slackLinkedResult.length > 0,
    userHasLinkedLinear: linearLinkedResult.length > 0,
    hasEnabledUserLevelMcp: enabledUserLevelMcpIds.length > 0,
    userHasConnectedEnabledUserLevelMcp:
      userConnectedEnabledMcpResult.length > 0,
    enabledUserLevelMcpIds,
    linkableProviders,
    githubAppSlug,
  };
}

export async function completeOnboardingCommand(
  auth: UserAuthSuccess,
  input?: { productUpdatesEnabled?: boolean },
) {
  const { userId } = auth;

  await db
    .update(users)
    .set({ onboardingCompletedAt: new Date() })
    .where(eq(users.id, userId));

  if (
    (input?.productUpdatesEnabled ?? true) &&
    !(auth.cloudEnabled && auth.isAdmin)
  ) {
    void subscribeToProductUpdates(auth.primaryEmail, 'onboarding');
  }

  return { success: true as const };
}

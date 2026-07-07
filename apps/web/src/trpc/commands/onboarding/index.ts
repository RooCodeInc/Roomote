import {
  db,
  users,
  slackInstallations,
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
import {
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';
import {
  LINEAR_ORG_CONNECTION_ROLE,
  LINEAR_USER_CONNECTION_ROLE,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

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
    orgHasSlack: slackInstallationResult.length > 0,
    orgHasLinear: linearInstallationResult.length > 0,
    userHasLinkedGitHub: githubLinkedResult.length > 0,
    userHasLinkedSlack: slackLinkedResult.length > 0,
    userHasLinkedLinear: linearLinkedResult.length > 0,
    hasEnabledUserLevelMcp: enabledUserLevelMcpIds.length > 0,
    userHasConnectedEnabledUserLevelMcp:
      userConnectedEnabledMcpResult.length > 0,
    enabledUserLevelMcpIds,
  };
}

export async function completeOnboardingCommand(auth: UserAuthSuccess) {
  const { userId } = auth;

  await db
    .update(users)
    .set({ onboardingCompletedAt: new Date() })
    .where(eq(users.id, userId));

  return { success: true as const };
}

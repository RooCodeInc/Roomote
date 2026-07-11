import {
  authAccounts,
  db,
  githubUserMappings,
  slackInstallations,
  slackUserMappings,
  telegramUserMappings,
  resolveTelegramRuntimeCredentials,
  and,
  desc,
  eq,
  mcpConnections,
} from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  findLinearUserMcpConnection,
} from '@roomote/sdk/server';

import { createTelegramLinkCode } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';

const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';

function formatGitLabLinkedAccountDisplayName(accountId: string) {
  return /^\d+$/.test(accountId) ? `GitLab user ${accountId}` : `@${accountId}`;
}

function formatGiteaLinkedAccountDisplayName(accountId: string) {
  return `Gitea user ${accountId}`;
}

function formatBitbucketLinkedAccountDisplayName(accountId: string) {
  return `Bitbucket user ${accountId}`;
}

function formatAdoLinkedAccountDisplayName(accountId: string) {
  return `Azure DevOps user ${accountId}`;
}

function decodeJwtPayload(
  token: string | null | undefined,
): Record<string, unknown> | null {
  const [, payload] = token?.split('.') ?? [];

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getMicrosoftTeamsAccountDisplayName(
  idToken: string | null | undefined,
): string | null {
  const claims = decodeJwtPayload(idToken);

  return (
    readNonEmptyString(claims?.preferred_username) ??
    readNonEmptyString(claims?.upn) ??
    readNonEmptyString(claims?.email) ??
    readNonEmptyString(claims?.name)
  );
}

function getMicrosoftTeamsTenantId(
  idToken: string | null | undefined,
): string | null {
  const claims = decodeJwtPayload(idToken);

  return readNonEmptyString(claims?.tid);
}

export async function getLinkedGitHubAccountCommand(auth: UserAuthSuccess) {
  const account = await db.query.githubUserMappings.findFirst({
    where: eq(githubUserMappings.userId, auth.userId),
    orderBy: [desc(githubUserMappings.updatedAt)],
    columns: {
      githubLogin: true,
    },
  });

  return account ?? null;
}

export async function getLinkedGitLabAccountCommand(auth: UserAuthSuccess) {
  const config = await resolveAuthProviderConfig();
  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, auth.userId),
      eq(authAccounts.providerId, 'gitlab'),
    ),
    orderBy: [desc(authAccounts.updatedAt)],
    columns: {
      accountId: true,
    },
  });

  return {
    configured: Boolean(config.gitlabClientId && config.gitlabClientSecret),
    account: account
      ? {
          accountId: account.accountId,
          displayName: formatGitLabLinkedAccountDisplayName(account.accountId),
        }
      : null,
  };
}

export async function getLinkedGiteaAccountCommand(auth: UserAuthSuccess) {
  const config = await resolveAuthProviderConfig();
  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, auth.userId),
      eq(authAccounts.providerId, 'gitea'),
    ),
    orderBy: [desc(authAccounts.updatedAt)],
    columns: {
      accountId: true,
    },
  });

  return {
    configured: Boolean(
      config.giteaClientId && config.giteaClientSecret && config.giteaBaseUrl,
    ),
    account: account
      ? {
          accountId: account.accountId,
          displayName: formatGiteaLinkedAccountDisplayName(account.accountId),
        }
      : null,
  };
}

export async function getLinkedBitbucketAccountCommand(auth: UserAuthSuccess) {
  const config = await resolveAuthProviderConfig();
  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, auth.userId),
      eq(authAccounts.providerId, 'bitbucket'),
    ),
    orderBy: [desc(authAccounts.updatedAt)],
    columns: {
      accountId: true,
    },
  });

  return {
    configured: Boolean(
      config.bitbucketClientId && config.bitbucketClientSecret,
    ),
    account: account
      ? {
          accountId: account.accountId,
          displayName: formatBitbucketLinkedAccountDisplayName(
            account.accountId,
          ),
        }
      : null,
  };
}

export async function getLinkedAdoAccountCommand(auth: UserAuthSuccess) {
  const config = await resolveAuthProviderConfig();
  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, auth.userId),
      eq(authAccounts.providerId, 'ado'),
    ),
    orderBy: [desc(authAccounts.updatedAt)],
    columns: {
      accountId: true,
    },
  });

  return {
    configured: Boolean(
      config.adoClientId && config.adoClientSecret && config.adoOrganization,
    ),
    account: account
      ? {
          accountId: account.accountId,
          displayName: formatAdoLinkedAccountDisplayName(account.accountId),
        }
      : null,
  };
}

export async function unlinkLinkedGitHubAccountCommand(auth: UserAuthSuccess) {
  const deleted = await db
    .delete(githubUserMappings)
    .where(eq(githubUserMappings.userId, auth.userId))
    .returning({ id: githubUserMappings.id });

  return {
    success: true as const,
    deletedCount: deleted.length,
  };
}

export async function getLinkedLinearAccountCommand(auth: UserAuthSuccess) {
  const connection = await findLinearUserMcpConnection({
    userId: auth.userId,
  });
  if (!connection) {
    return null;
  }

  const authConfig = connection.authConfig;
  if (
    !authConfig ||
    typeof authConfig !== 'object' ||
    !('linearUserId' in authConfig) ||
    !('linearOrganizationId' in authConfig)
  ) {
    return null;
  }

  const installation = await findLinearDeploymentMcpConnection();
  const installationConfig = installation?.authConfig;

  return {
    linearUserId: authConfig.linearUserId,
    linearOrganizationId: authConfig.linearOrganizationId,
    linearOrganizationName:
      installationConfig &&
      typeof installationConfig === 'object' &&
      'linearOrganizationName' in installationConfig
        ? (installationConfig.linearOrganizationName ?? null)
        : null,
    linearOrganizationUrlKey:
      installationConfig &&
      typeof installationConfig === 'object' &&
      'linearOrganizationUrlKey' in installationConfig
        ? (installationConfig.linearOrganizationUrlKey ?? null)
        : null,
  };
}

export async function unlinkLinkedLinearAccountCommand(auth: UserAuthSuccess) {
  const deleted = await db
    .delete(mcpConnections)
    .where(
      and(
        eq(mcpConnections.userId, auth.userId),
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.connectionRole, 'linear_user_link'),
      ),
    )
    .returning({ id: mcpConnections.id });

  return {
    success: true as const,
    deletedCount: deleted.length,
  };
}

export async function getLinkedSlackAccountCommand(auth: UserAuthSuccess) {
  const mapping = await db.query.slackUserMappings.findFirst({
    where: eq(slackUserMappings.userId, auth.userId),
    orderBy: [desc(slackUserMappings.updatedAt)],
    columns: {
      slackUserId: true,
      slackTeamId: true,
    },
  });

  if (!mapping) {
    return null;
  }

  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.teamId, mapping.slackTeamId),
    columns: {
      teamName: true,
    },
  });

  return {
    ...mapping,
    teamName: installation?.teamName ?? null,
  };
}

export async function unlinkLinkedSlackAccountCommand(auth: UserAuthSuccess) {
  const deleted = await db
    .delete(slackUserMappings)
    .where(eq(slackUserMappings.userId, auth.userId))
    .returning({ id: slackUserMappings.id });

  return {
    success: true as const,
    deletedCount: deleted.length,
  };
}

export async function getLinkedMicrosoftTeamsAccountCommand(
  auth: UserAuthSuccess,
) {
  const configured = Boolean(
    Env.R_MICROSOFT_CLIENT_ID &&
    Env.R_MICROSOFT_CLIENT_SECRET &&
    Env.R_MICROSOFT_TENANT_ID,
  );

  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, auth.userId),
      eq(authAccounts.providerId, MICROSOFT_ENTRA_PROVIDER_ID),
    ),
    orderBy: [desc(authAccounts.updatedAt)],
    columns: {
      accountId: true,
      idToken: true,
    },
  });

  return {
    configured,
    account: account
      ? {
          accountId: account.accountId,
          displayName: getMicrosoftTeamsAccountDisplayName(account.idToken),
          tenantId: getMicrosoftTeamsTenantId(account.idToken),
        }
      : null,
  };
}

export async function getLinkedTelegramAccountCommand(auth: UserAuthSuccess) {
  const [{ botToken }, mapping] = await Promise.all([
    resolveTelegramRuntimeCredentials(),
    db.query.telegramUserMappings.findFirst({
      where: eq(telegramUserMappings.userId, auth.userId),
      orderBy: [desc(telegramUserMappings.updatedAt)],
      columns: {
        telegramUserId: true,
        telegramUsername: true,
      },
    }),
  ]);

  return {
    configured: Boolean(botToken),
    mapping: mapping ?? null,
  };
}

export async function createTelegramLinkCodeCommand(auth: UserAuthSuccess) {
  const { botToken, botUsername } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    throw new Error(
      'Telegram is not configured for this deployment. Set it up under Settings → Communications first.',
    );
  }

  const { code, expiresInSeconds } = await createTelegramLinkCode(auth.userId);

  return {
    code,
    expiresInSeconds,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  };
}

export async function unlinkLinkedTelegramAccountCommand(
  auth: UserAuthSuccess,
) {
  const deleted = await db
    .delete(telegramUserMappings)
    .where(eq(telegramUserMappings.userId, auth.userId))
    .returning({ id: telegramUserMappings.id });

  return {
    success: true as const,
    deletedCount: deleted.length,
  };
}

import {
  buildDiscordInvocationIdentity,
  buildGenericInvocationIdentity,
  buildGitHubInvocationIdentity,
  buildSlackInvocationIdentity,
  buildTeamsInvocationIdentity,
  buildTelegramInvocationIdentity,
  type InvocationIdentity,
} from '@roomote/types';
import { desc, eq } from 'drizzle-orm';

import { db } from '../db';
import { slackInstallations, teamsInstallations } from '../schema';
import { resolveDiscordRuntimeCredentials } from './discord-runtime-credentials';
import { getDeploymentGitHubRoomoteMentionEnabled } from './github-mention-settings';
import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';
import { resolveTelegramRuntimeCredentials } from './telegram-runtime-credentials';

const TEAMS_PACKAGE_DEFAULT_BOT_NAME = 'Roomote';

function readConfiguredValue(
  name: string,
  deploymentEnvVars: Record<string, string | undefined>,
): string | null {
  return process.env[name]?.trim() || deploymentEnvVars[name]?.trim() || null;
}

export async function resolveInvocationIdentities(): Promise<
  InvocationIdentity[]
> {
  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const [
    slackInstallation,
    teamsInstallation,
    telegramCredentials,
    discordCredentials,
    githubRoomoteMentionEnabled,
  ] = await Promise.all([
    db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      orderBy: [desc(slackInstallations.updatedAt)],
      columns: {
        botUserId: true,
        botName: true,
        appName: true,
      },
    }),
    db.query.teamsInstallations.findFirst({
      where: eq(teamsInstallations.isActive, true),
      orderBy: [desc(teamsInstallations.updatedAt)],
      columns: {
        botName: true,
      },
    }),
    resolveTelegramRuntimeCredentials(),
    resolveDiscordRuntimeCredentials(),
    getDeploymentGitHubRoomoteMentionEnabled(),
  ]);

  const githubSlug = readConfiguredValue(
    'R_GITHUB_APP_SLUG',
    deploymentEnvVars,
  );
  const configuredTeamsBotName = readConfiguredValue(
    'R_TEAMS_BOT_NAME',
    deploymentEnvVars,
  );
  const teamsBotName =
    configuredTeamsBotName ??
    teamsInstallation?.botName ??
    TEAMS_PACKAGE_DEFAULT_BOT_NAME;

  return [
    buildSlackInvocationIdentity({
      botUserId: slackInstallation?.botUserId ?? null,
      botName: slackInstallation?.botName ?? null,
      appName: slackInstallation?.appName ?? null,
    }),
    buildTeamsInvocationIdentity({
      displayName: teamsBotName,
      configured: Boolean(configuredTeamsBotName || teamsInstallation?.botName),
    }),
    buildTelegramInvocationIdentity(telegramCredentials.botUsername),
    buildDiscordInvocationIdentity({
      botUserId: discordCredentials.botUserId,
      username: discordCredentials.botUsername,
      displayName: discordCredentials.botDisplayName,
    }),
    buildGitHubInvocationIdentity(githubSlug, githubRoomoteMentionEnabled),
    buildGenericInvocationIdentity('linear', 'Linear'),
    buildGenericInvocationIdentity('gitlab', 'GitLab'),
    buildGenericInvocationIdentity('gitea', 'Gitea'),
    buildGenericInvocationIdentity('bitbucket', 'Bitbucket'),
    buildGenericInvocationIdentity('ado', 'Azure DevOps'),
  ];
}

export async function resolveInvocationIdentityMap(): Promise<
  Record<string, InvocationIdentity>
> {
  const identities = await resolveInvocationIdentities();
  return Object.fromEntries(
    identities.map((identity) => [identity.provider, identity]),
  );
}

export async function resolveTeamsInvocationBotName(): Promise<string> {
  const identities = await resolveInvocationIdentities();
  const teamsIdentity = identities.find(
    (identity) => identity.provider === 'microsoft',
  );

  return teamsIdentity?.displayName ?? TEAMS_PACKAGE_DEFAULT_BOT_NAME;
}

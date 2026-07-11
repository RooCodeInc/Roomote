import { Octokit } from '@octokit/rest';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { Env } from '@roomote/env';
import { normalizePemEnvValue } from '@roomote/types';
import {
  type GitHubInstallation,
  db,
  users,
  githubInstallations,
  eq,
  and,
  isNull,
  desc,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

export const createGitHubTokenOptionsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activeInstallation') }),
  z.object({ type: z.literal('userId'), userId: z.string() }),
  z.object({
    type: z.literal('installationId'),
    installationId: z.string().or(z.number()),
    // GitHub repository ids to scope the token to. When omitted, the token
    // covers every repository in the installation.
    repositoryIds: z.array(z.number()).optional(),
  }),
]);

export type CreateGitHubTokenOptions = z.infer<
  typeof createGitHubTokenOptionsSchema
>;

export async function createGitHubToken(
  options: CreateGitHubTokenOptions,
  octokitOptions?: GitHubAppCredentials,
): Promise<string> {
  let installation: GitHubInstallation | undefined;

  if (options.type === 'activeInstallation') {
    const activeInstallations = await db.query.githubInstallations.findMany({
      where: isNull(githubInstallations.suspendedAt),
      orderBy: [desc(githubInstallations.createdAt)],
      limit: 2,
    });

    if (activeInstallations.length > 1) {
      throw new Error(
        'Multiple active GitHub installations found. Select a specific environment or repository before starting this task.',
      );
    }

    installation = activeInstallations[0];
  } else if (options.type === 'userId') {
    const user = await db.query.users.findFirst({
      where: eq(users.id, options.userId),
    });

    installation = user
      ? await db.query.githubInstallations.findFirst({
          where: and(
            eq(githubInstallations.userId, user.id),
            isNull(githubInstallations.suspendedAt),
          ),
          orderBy: [desc(githubInstallations.createdAt)],
        })
      : undefined;
  } else if (options.type === 'installationId') {
    installation =
      typeof options.installationId === 'string'
        ? await db.query.githubInstallations.findFirst({
            where: eq(githubInstallations.id, options.installationId),
          })
        : await db.query.githubInstallations.findFirst({
            where: eq(
              githubInstallations.installationId,
              options.installationId,
            ),
          });
  } else {
    throw new Error('Invalid options.');
  }

  if (!installation) {
    throw new Error('❌ GitHub installation not found');
  }

  const appCredentials =
    await resolveRuntimeGitHubAppCredentials(octokitOptions);

  // Scope the token to specific repositories when the caller supplied them, so
  // a task token cannot read or write other repositories in the installation.
  const repositoryIds =
    options.type === 'installationId' ? options.repositoryIds : undefined;

  const {
    data: { token },
  } = await getOctokit(appCredentials).rest.apps.createInstallationAccessToken({
    installation_id: installation.installationId,
    ...(repositoryIds && repositoryIds.length > 0
      ? { repository_ids: repositoryIds }
      : {}),
  });

  return token;
}

export type GitHubAppCredentials = { appId: string; privateKey: string };

export function resolveGitHubAppCredentials(
  options?: GitHubAppCredentials,
): GitHubAppCredentials {
  if (options) {
    return options;
  }

  return {
    appId: Env.R_GITHUB_APP_ID,
    privateKey: Env.R_GITHUB_APP_PRIVATE_KEY,
  };
}

export async function resolveRuntimeGitHubAppCredentials(
  options?: GitHubAppCredentials,
): Promise<GitHubAppCredentials> {
  if (options) {
    return options;
  }

  const [appId, privateKey] = await Promise.all([
    resolveDeploymentEnvVar('R_GITHUB_APP_ID'),
    resolveDeploymentEnvVar('R_GITHUB_APP_PRIVATE_KEY'),
  ]);

  if (appId && privateKey) {
    return { appId, privateKey };
  }

  const envCredentials = resolveGitHubAppCredentials();

  if (envCredentials.appId.trim() && envCredentials.privateKey.trim()) {
    return envCredentials;
  }

  throw new Error('GitHub App credentials are not configured.');
}

function getOctokit(options?: GitHubAppCredentials): Octokit {
  const now = Math.floor(Date.now() / 1000);
  const { appId, privateKey } = resolveGitHubAppCredentials(options);

  const auth = jwt.sign(
    { iat: now, exp: now + 300, iss: appId },
    normalizePemEnvValue(
      privateKey.replace(/\\n/g, '\n').replace(/"/g, '').trim(),
    ),
    { algorithm: 'RS256' },
  );

  return new Octokit({ auth, userAgent: 'Roomote' });
}

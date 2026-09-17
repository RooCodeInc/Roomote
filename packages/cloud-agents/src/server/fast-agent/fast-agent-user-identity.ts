import {
  db,
  eq,
  isDeploymentExperimentEnabled,
  users,
} from '@roomote/db/server';

import { findLatestGithubIdentityForUser } from '../commit-author';

interface FastAgentUserIdentity {
  displayName: string | null;
  githubLogin: string | null;
  isAdmin: boolean;
  serviceCredentialToolsEnabled: boolean;
}

export async function getFastAgentUserIdentity(
  userId: string,
): Promise<FastAgentUserIdentity> {
  const [user, githubIdentity, serviceCredentialToolsEnabled] =
    await Promise.all([
      db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { name: true, role: true, deletedAt: true },
      }),
      findLatestGithubIdentityForUser(db, userId),
      isDeploymentExperimentEnabled('serviceCredentialTools'),
    ]);

  return {
    displayName: user?.name?.trim() || null,
    githubLogin: githubIdentity.githubLogin,
    isAdmin: user?.role === 'admin',
    serviceCredentialToolsEnabled:
      !user?.deletedAt && serviceCredentialToolsEnabled,
  };
}

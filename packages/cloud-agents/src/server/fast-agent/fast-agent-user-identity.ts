import { db, eq, users } from '@roomote/db/server';
import { isSessionSecretToolsExperimentEnabled } from '@roomote/types';

import { findLatestGithubIdentityForUser } from '../commit-author';

interface FastAgentUserIdentity {
  displayName: string | null;
  githubLogin: string | null;
  isAdmin: boolean;
  sessionSecretToolsEnabled: boolean;
}

export async function getFastAgentUserIdentity(
  userId: string,
): Promise<FastAgentUserIdentity> {
  const [user, githubIdentity] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, role: true, metadata: true },
    }),
    findLatestGithubIdentityForUser(db, userId),
  ]);

  return {
    displayName: user?.name?.trim() || null,
    githubLogin: githubIdentity.githubLogin,
    isAdmin: user?.role === 'admin',
    sessionSecretToolsEnabled: isSessionSecretToolsExperimentEnabled(
      user?.metadata,
    ),
  };
}

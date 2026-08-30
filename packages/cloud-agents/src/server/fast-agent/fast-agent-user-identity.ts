import { db, eq, users } from '@roomote/db/server';

import { findLatestGithubIdentityForUser } from '../commit-author';

interface FastAgentUserIdentity {
  displayName: string | null;
  githubLogin: string | null;
}

export async function getFastAgentUserIdentity(
  userId: string,
): Promise<FastAgentUserIdentity> {
  const [user, githubIdentity] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    }),
    findLatestGithubIdentityForUser(db, userId),
  ]);

  return {
    displayName: user?.name?.trim() || null,
    githubLogin: githubIdentity.githubLogin,
  };
}

import type { AuthTokenContext } from '@roomote/types';
import { db, users, eq } from '@roomote/db/server';

export const me = async (auth: AuthTokenContext) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
  });

  if (user) {
    return { type: 'user', user };
  }

  return null;
};

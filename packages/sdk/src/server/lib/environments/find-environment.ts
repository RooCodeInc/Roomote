import type { AuthTokenContext, JobTokenContext } from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';

export const findEnvironment = async (
  _auth: AuthTokenContext | JobTokenContext,
  id: string,
) => {
  return db.query.environments.findFirst({
    where: eq(environments.id, id),
  });
};

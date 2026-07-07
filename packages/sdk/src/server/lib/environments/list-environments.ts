import type { AuthTokenContext } from '@roomote/types';
import { db, environments } from '@roomote/db/server';

export const listEnvironments = async (_auth: AuthTokenContext) => {
  return db.query.environments.findMany({
    orderBy: [environments.name],
  });
};

import type {
  AuthTokenContext,
  JobTokenContext,
  SourceControlProvider,
} from '@roomote/types';
import { db, repositories, eq, and } from '@roomote/db/server';

export const listRepositories = (
  auth: AuthTokenContext | JobTokenContext,
  input?: { sourceControlProvider?: SourceControlProvider },
) => {
  // Repositories are deployment-scoped: any authenticated principal may
  // read them, including deployment-service-principal job tokens.
  return db.query.repositories.findMany({
    where: input?.sourceControlProvider
      ? and(
          eq(repositories.isActive, true),
          eq(repositories.sourceControlProvider, input.sourceControlProvider),
        )
      : eq(repositories.isActive, true),
  });
};

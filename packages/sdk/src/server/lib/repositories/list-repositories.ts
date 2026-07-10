import type {
  AuthTokenContext,
  RunTokenContext,
  SourceControlProvider,
} from '@roomote/types';
import { db, repositories, eq, and } from '@roomote/db/server';

export const listRepositories = (
  auth: AuthTokenContext | RunTokenContext,
  input?: { sourceControlProvider?: SourceControlProvider },
) => {
  // Repositories are deployment-scoped: any authenticated principal may
  // read them, including deployment-service-principal run tokens.
  return db.query.repositories.findMany({
    where: input?.sourceControlProvider
      ? and(
          eq(repositories.isActive, true),
          eq(repositories.sourceControlProvider, input.sourceControlProvider),
        )
      : eq(repositories.isActive, true),
  });
};

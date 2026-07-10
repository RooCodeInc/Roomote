import type {
  AuthTokenContext,
  JobTokenContext,
  SourceControlProvider,
} from '@roomote/types';
import { db, repositories, eq, and } from '@roomote/db/server';

export const findRepository = (
  auth: AuthTokenContext | JobTokenContext,
  fullName: string,
  input?: { sourceControlProvider?: SourceControlProvider },
) => {
  // Repositories are deployment-scoped: any authenticated principal may
  // read them, including deployment-service-principal job tokens minted for
  // automation runs (which carry no user claim).
  return db.query.repositories.findFirst({
    where: and(
      eq(repositories.isActive, true),
      eq(repositories.fullName, fullName),
      ...(input?.sourceControlProvider
        ? [eq(repositories.sourceControlProvider, input.sourceControlProvider)]
        : []),
    ),
  });
};

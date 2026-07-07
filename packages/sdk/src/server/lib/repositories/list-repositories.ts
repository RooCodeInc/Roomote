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
  if (!auth.userId) {
    throw new Error('Invalid authorization token.');
  }

  return db.query.repositories.findMany({
    where: input?.sourceControlProvider
      ? and(
          eq(repositories.isActive, true),
          eq(repositories.sourceControlProvider, input.sourceControlProvider),
        )
      : eq(repositories.isActive, true),
  });
};

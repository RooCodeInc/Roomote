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
  if (!auth.userId) {
    throw new Error('Invalid authorization token.');
  }

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

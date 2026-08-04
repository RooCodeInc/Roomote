import { ALL_REPOSITORIES } from '@roomote/types';
import { db, inArray, repositories } from '@roomote/db/server';

import type { ResolvedRepository, SuggestedTasksPayload } from './types.js';

function getSuggestedTaskRepositoryFullNames(
  payload: SuggestedTasksPayload,
): string[] {
  if (payload.repo === ALL_REPOSITORIES) {
    return [...new Set(payload.selectedRepositories ?? [])];
  }

  if (payload.repo?.trim()) {
    return [payload.repo.trim()];
  }

  return [];
}

export async function resolveRepositoryIdsForSuggestedTask(params: {
  payload: SuggestedTasksPayload;
}): Promise<ResolvedRepository[]> {
  const repositoryFullNames = getSuggestedTaskRepositoryFullNames(
    params.payload,
  );

  if (repositoryFullNames.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, repositoryFullNames));

  const rowsByFullName = new Map(
    rows.map((repository) => [repository.fullName, repository]),
  );

  return repositoryFullNames
    .map((repositoryFullName) => rowsByFullName.get(repositoryFullName))
    .filter((repository): repository is ResolvedRepository =>
      Boolean(repository),
    );
}

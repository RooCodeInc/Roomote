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
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, repositoryFullNames));

  const sourceControlHost = params.payload.sourceControlHost?.trim();
  const scopedRows = rows.filter((repository) => {
    const sourceControlProvider =
      params.payload.sourceControlProvider ??
      params.payload.repositoryProviders?.[repository.fullName];

    return (
      (!sourceControlProvider ||
        repository.sourceControlProvider === sourceControlProvider) &&
      (!sourceControlHost || repository.host === sourceControlHost)
    );
  });

  return repositoryFullNames.flatMap((repositoryFullName) =>
    scopedRows
      .filter((repository) => repository.fullName === repositoryFullName)
      .map(({ id, fullName }) => ({ id, fullName })),
  );
}

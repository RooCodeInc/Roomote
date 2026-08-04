import {
  buildEnvironmentDefinitionWorkspacePayload,
  normalizeRepositorySelection,
  type TaskLaunchWorkspacePayload,
} from '@roomote/types';
import { inArray } from 'drizzle-orm';

import { db, type DatabaseOrTransaction } from '../db';
import { repositories } from '../schema';

export type ResolvedRepositorySelection = {
  normalizedRepositoryIds: string[];
  selectedRepositories: Array<{
    id: string;
    fullName: string;
  }>;
  workspacePayload: TaskLaunchWorkspacePayload | null;
};

export async function resolveRepositorySelectionByIds(params: {
  repositoryIds: string[];
  executor?: DatabaseOrTransaction;
}): Promise<ResolvedRepositorySelection> {
  if (params.repositoryIds.length === 0) {
    return {
      normalizedRepositoryIds: [],
      selectedRepositories: [],
      workspacePayload: null,
    };
  }

  const executor = params.executor ?? db;
  const repositoryIds = [...new Set(params.repositoryIds)];
  const rows = await executor
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(inArray(repositories.id, repositoryIds));

  const rowsById = new Map(
    rows.map((repository) => [repository.id, repository]),
  );
  const selectedRepositories = repositoryIds
    .map((repositoryId) => rowsById.get(repositoryId))
    .filter(
      (
        repository,
      ): repository is ResolvedRepositorySelection['selectedRepositories'][number] =>
        Boolean(repository),
    );

  return {
    normalizedRepositoryIds: normalizeRepositorySelection(selectedRepositories),
    selectedRepositories,
    workspacePayload:
      selectedRepositories.length > 0
        ? buildEnvironmentDefinitionWorkspacePayload(
            selectedRepositories.map((repository) => repository.fullName),
          )
        : null,
  };
}

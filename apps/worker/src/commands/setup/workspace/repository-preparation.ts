import { ExecutionError } from '../../../command-executor/command-executor';

import {
  type RepositoryPreparationIssue,
  type WorkspaceRepositoryPreparationFailure,
  type WorkspaceRepositoryPreparationWorkspaceType,
  WorkspaceRepositoryPreparationError,
} from './types';

export function createRepositoryPreparationIssue(
  repository: string,
  error: unknown,
): RepositoryPreparationIssue {
  return {
    repository,
    reason: error instanceof Error ? error.message : String(error),
    diagnostics:
      error instanceof ExecutionError ? error.formatDetails() : undefined,
  };
}

export function createWorkspaceRepositoryPreparationError(params: {
  workspaceType: WorkspaceRepositoryPreparationWorkspaceType;
  totalRepositories: number;
  preparedRepositoryCount: number;
  failures: Array<{
    repository: string;
    error: unknown;
  }>;
}): WorkspaceRepositoryPreparationError {
  const failure: WorkspaceRepositoryPreparationFailure = {
    mode: 'fatal',
    workspaceType: params.workspaceType,
    totalRepositories: params.totalRepositories,
    preparedRepositoryCount: params.preparedRepositoryCount,
    repositories: params.failures.map(({ repository, error }) =>
      createRepositoryPreparationIssue(repository, error),
    ),
  };

  return new WorkspaceRepositoryPreparationError(failure);
}

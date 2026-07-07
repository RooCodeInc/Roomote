import {
  type EnvironmentConfig,
  resolveCloudTaskWorkspace,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

import type {
  WorkspaceConfig,
  RepositoryWorkspace,
  RepositorySetWorkspace,
  AllRepositoriesWorkspace,
  EnvironmentWorkspace,
} from '../../workspace';

export async function findRuntimeEnvironmentConfig(
  environmentId: string,
): Promise<EnvironmentConfig | undefined> {
  const environment = await sdk.environments.findEnvironment(environmentId);

  return environment ? (environment.config as EnvironmentConfig) : undefined;
}

export async function buildWorkspaceConfig({
  environmentId,
  repo,
  branch,
  sha,
  selectedRepositories,
}: {
  environmentId?: string;
  repo?: string;
  branch?: string;
  sha?: string;
  selectedRepositories?: string[];
}): Promise<WorkspaceConfig> {
  const workspace = resolveCloudTaskWorkspace({
    repo,
    branch,
    sha,
    environmentId,
    selectedRepositories,
  });

  if (workspace.type === 'environment') {
    const environmentConfig = await findRuntimeEnvironmentConfig(
      workspace.environmentId,
    );

    if (!environmentConfig) {
      throw new Error(`Environment not found: ${workspace.environmentId}`);
    }

    return {
      type: 'environment',
      environmentId: workspace.environmentId,
      environmentConfig,
      sourceRepo: workspace.sourceRepo,
      sourceBranch: workspace.sourceBranch,
      sourceSha: workspace.sourceSha,
    } satisfies EnvironmentWorkspace;
  }

  if (workspace.type === 'repository') {
    return {
      type: 'repository',
      repository: workspace.repo,
      branch: workspace.branch,
      sha: workspace.sha,
    } satisfies RepositoryWorkspace;
  }

  if (workspace.type === 'repository_set') {
    return {
      type: 'repository_set',
      repositories: workspace.repositories,
    } satisfies RepositorySetWorkspace;
  }

  return {
    type: 'all_repositories',
  } satisfies AllRepositoriesWorkspace;
}

import type { EnvironmentConfig } from '@roomote/types';

/**
 * Workspace configuration for single-repository mode.
 */
export interface RepositoryWorkspace {
  type: 'repository';
  repository: string;
  branch?: string;
  sha?: string;
}

/**
 * Workspace configuration for a scoped multi-repository shared root.
 */
export interface RepositorySetWorkspace {
  type: 'repository_set';
  repositories: string[];
}

/**
 * Workspace configuration for the shared root containing all repositories.
 */
export interface AllRepositoriesWorkspace {
  type: 'all_repositories';
}

/**
 * Workspace configuration for environment mode.
 */
export interface EnvironmentWorkspace {
  type: 'environment';
  environmentId: string;
  environmentConfig: EnvironmentConfig;
  /**
   * Repository from the triggering context (e.g. PR preview link).
   * Used to selectively pin one repo inside an environment.
   */
  sourceRepo?: string;
  sourceBranch?: string;
  sourceSha?: string;
}

export type WorkspaceConfig =
  | RepositoryWorkspace
  | RepositorySetWorkspace
  | AllRepositoriesWorkspace
  | EnvironmentWorkspace;

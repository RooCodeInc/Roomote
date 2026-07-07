import type {
  CodingHarness,
  CloudTaskType,
  SourceControlProvider,
} from '@roomote/types';

import type { ServiceContext } from '../../../services';
import type { WorkspaceConfig } from '../../../workspace';
import type { RepoLocalSkill } from '../../../workspace/repo-local-skills';

export type WorkspaceRepositoryPreparationWorkspaceType =
  WorkspaceConfig['type'];

export type WorkspaceRepositoryPreparationContinuedWorkspaceType = Extract<
  WorkspaceRepositoryPreparationWorkspaceType,
  'all_repositories' | 'repository_set'
>;

export interface RepositoryPreparationIssue {
  repository: string;
  reason: string;
  diagnostics?: string;
}

interface WorkspaceRepositoryPreparationBase {
  totalRepositories: number;
  preparedRepositoryCount: number;
  repositories: RepositoryPreparationIssue[];
}

export interface WorkspaceRepositoryPreparationContinued extends WorkspaceRepositoryPreparationBase {
  mode: 'continued';
  workspaceType: WorkspaceRepositoryPreparationContinuedWorkspaceType;
}

export interface WorkspaceRepositoryPreparationFailure extends WorkspaceRepositoryPreparationBase {
  mode: 'fatal';
  workspaceType: WorkspaceRepositoryPreparationWorkspaceType;
}

export interface PreparedEnvironment {
  repoPaths: Record<string, string>;
}

export interface EnvironmentSetupWarning {
  message: string;
}

export interface PrepareWorkspaceResult {
  workspacePath: string;
  environment?: PreparedEnvironment;
  repoPaths?: Record<string, string>;
  repoLocalSkills?: RepoLocalSkill[];
  usesSharedWorkspaceRoot?: boolean;
  repositoryPreparationOutcome?: WorkspaceRepositoryPreparationContinued;
  environmentSetupWarnings?: EnvironmentSetupWarning[];
}

export interface PrepareWorkspaceOptions {
  workspace: WorkspaceConfig;
  envVars: Record<string, string | undefined>;
  /** User-specified environment variables stored (encrypted) in the database. */
  userEnvVars?: Record<string, string>;
  harness?: CodingHarness | null;
  cloudJobType: CloudTaskType;
  preserveGitState?: boolean;
  cleanupLegacyPaths?: boolean;
  sourceControlProvider?: SourceControlProvider;
  serviceContext?: ServiceContext;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

function formatWorkspaceRepositoryPreparationMessage(
  failure: WorkspaceRepositoryPreparationFailure,
): string {
  const details = failure.repositories
    .map(
      (item) =>
        `- ${item.repository}: ${item.reason}${
          item.diagnostics ? `\n${item.diagnostics}` : ''
        }`,
    )
    .join('\n');

  return `Failed to prepare ${failure.repositories.length} workspace repositor${
    failure.repositories.length === 1 ? 'y' : 'ies'
  }:\n${details}`;
}

export class WorkspaceRepositoryPreparationError extends Error {
  constructor(public readonly failure: WorkspaceRepositoryPreparationFailure) {
    super(formatWorkspaceRepositoryPreparationMessage(failure));
    this.name = 'WorkspaceRepositoryPreparationError';
  }
}

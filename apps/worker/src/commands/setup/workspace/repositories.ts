import pLimit from 'p-limit';

import { sdk } from '@roomote/sdk/client';
import { DEFAULT_SOURCE_CONTROL_PROVIDER } from '@roomote/types';

import type { StartupLogger } from '../../../logging';
import { discoverRepoLocalSkills } from '../../../workspace/repo-local-skills';

import {
  type PrepareWorkspaceOptions,
  type PrepareWorkspaceResult,
  type RepositoryPreparationIssue,
} from './types';
import {
  createRepositoryPreparationIssue,
  createWorkspaceRepositoryPreparationError,
} from './repository-preparation';
import { applyEnvironmentEnvVars, createWorkspaceManager } from './shared';
import { timedStep } from '../logging';

// Limit concurrent repository preparations to avoid overwhelming system resources.
const REPO_PREPARATION_CONCURRENCY = 5;

function summarizeSkippedRepositories(
  skippedRepositories: RepositoryPreparationIssue[],
): string {
  const sample = skippedRepositories
    .slice(0, 3)
    .map((item) => item.repository)
    .join(', ');
  const remainder =
    skippedRepositories.length - Math.min(3, skippedRepositories.length);

  return remainder > 0 ? `${sample}, +${remainder} more` : sample;
}

function formatWorkspacePreparationLabel(
  workspaceType: PrepareWorkspaceOptions['workspace']['type'],
): string {
  return workspaceType === 'all_repositories'
    ? 'all-repositories workspace'
    : `${workspaceType} workspace`;
}

async function discoverWorkspaceRepoLocalSkills({
  repoPaths,
  repoFullNamesByDir,
}: {
  repoPaths: Record<string, string>;
  repoFullNamesByDir?: Record<string, string>;
}) {
  return await discoverRepoLocalSkills({ repoPaths, repoFullNamesByDir });
}

/**
 * Prepare workspace for a task run.
 * Supports single-repository, scoped multi-repository, all-repositories, and
 * environment workspaces.
 *
 * @param preserveGitState - If true, skip git fetch/reset/clean/checkout operations.
 *   Used for resume scenarios where we want to preserve the snapshot's git state.
 */
export async function initializeRepositories(
  logger: StartupLogger,
  {
    workspace,
    envVars,
    preserveGitState = false,
    cleanupLegacyPaths = false,
    gitAuthorName,
    gitAuthorEmail,
    sourceControlProvider,
  }: PrepareWorkspaceOptions,
): Promise<PrepareWorkspaceResult> {
  const resolvedSourceControlProvider =
    sourceControlProvider ?? DEFAULT_SOURCE_CONTROL_PROVIDER;
  const sourceControlPrepareOptions =
    resolvedSourceControlProvider === DEFAULT_SOURCE_CONTROL_PROVIDER
      ? {}
      : { sourceControlProvider: resolvedSourceControlProvider };
  const { workspaceRoot, workspaceManager } = createWorkspaceManager(
    envVars,
    logger,
  );

  await timedStep(logger, 'initializeRepositories: configure git', () =>
    workspaceManager.configure({ gitAuthorName, gitAuthorEmail }),
  );

  switch (workspace.type) {
    case 'environment': {
      applyEnvironmentEnvVars(workspace, envVars);

      const preparedRepositories = await timedStep(
        logger,
        'initializeRepositories: prepare environment repositories',
        () =>
          workspaceManager.prepareEnvironmentRepositories(
            workspace.environmentConfig,
            preserveGitState,
            cleanupLegacyPaths,
            {
              sourceRepo: workspace.sourceRepo,
              sourceBranch: workspace.sourceBranch,
              sourceSha: workspace.sourceSha,
            },
            sourceControlPrepareOptions,
          ),
      );

      await timedStep(
        logger,
        'initializeRepositories: install workspace tool versions',
        () =>
          workspaceManager.installWorkspaceToolVersions(
            workspace.environmentConfig.tool_versions,
          ),
      );

      const environment = { repoPaths: preparedRepositories.repoPaths };
      const repoLocalSkills = await discoverWorkspaceRepoLocalSkills({
        repoPaths: environment.repoPaths,
        repoFullNamesByDir: Object.fromEntries(
          workspace.environmentConfig.repositories.map((repoConfig) => [
            repoConfig.repository,
            repoConfig.repository,
          ]),
        ),
      });

      return {
        workspacePath: workspaceRoot,
        environment,
        repoPaths: environment.repoPaths,
        repoLocalSkills,
        usesSharedWorkspaceRoot: true,
      };
    }

    case 'repository_set':
    case 'all_repositories': {
      const repositoriesToPrepare =
        workspace.type === 'repository_set'
          ? workspace.repositories.map((fullName) => ({ fullName }))
          : await timedStep(
              logger,
              'initializeRepositories: list repositories',
              () =>
                sdk.repositories.listRepositories({
                  sourceControlProvider: resolvedSourceControlProvider,
                }),
            );

      const limit = pLimit(REPO_PREPARATION_CONCURRENCY);

      const preparationResults = await Promise.allSettled(
        repositoriesToPrepare.map((repo) =>
          limit(async () => {
            const repoPath = await timedStep(
              logger,
              `initializeRepositories: prepare ${repo.fullName}`,
              () =>
                workspaceManager.prepareRepository(
                  repo.fullName,
                  undefined,
                  undefined,
                  preserveGitState,
                  cleanupLegacyPaths,
                  {
                    ...sourceControlPrepareOptions,
                  },
                ),
            );

            return {
              repo: repo.fullName,
              repoFullName: repo.fullName,
              repoName: repo.fullName,
              repoPath,
            };
          }),
        ),
      );

      const preparedRepositories = preparationResults
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            repo: string;
            repoFullName: string;
            repoName: string;
            repoPath: string;
          }> => result.status === 'fulfilled',
        )
        .map((result) => result.value);

      const failedPreparations = preparationResults
        .map((result, index) => ({
          result,
          repo: repositoriesToPrepare[index]?.fullName,
        }))
        .filter(
          (
            item,
          ): item is {
            result: PromiseRejectedResult;
            repo: string | undefined;
          } => item.result.status === 'rejected',
        );

      const failedRepositories = failedPreparations.map(({ result, repo }) =>
        createRepositoryPreparationIssue(
          repo ?? 'unknown repository',
          result.reason,
        ),
      );

      if (failedPreparations.length > 0) {
        if (preparedRepositories.length > 0) {
          const workspaceLabel = formatWorkspacePreparationLabel(
            workspace.type,
          );

          logger.userLog.warn(
            `Skipped ${failedRepositories.length} repositor${
              failedRepositories.length === 1 ? 'y' : 'ies'
            } while preparing the ${workspaceLabel} and continued with ${
              preparedRepositories.length
            } prepared repositor${
              preparedRepositories.length === 1 ? 'y' : 'ies'
            }: ${summarizeSkippedRepositories(failedRepositories)}`,
          );
          logger.debug.warn(
            `initializeRepositories: skipped ${failedRepositories.length} ${workspaceLabel} repositor${
              failedRepositories.length === 1 ? 'y' : 'ies'
            } after preparing ${preparedRepositories.length}.`,
          );

          const repoPaths = Object.fromEntries(
            preparedRepositories.map((result) => [
              result.repoName,
              result.repoPath,
            ]),
          );
          const repoLocalSkills = await discoverWorkspaceRepoLocalSkills({
            repoPaths,
            repoFullNamesByDir: Object.fromEntries(
              preparedRepositories.map((result) => [
                result.repoName,
                result.repoFullName,
              ]),
            ),
          });

          return {
            workspacePath: workspaceRoot,
            repoPaths,
            repoLocalSkills,
            usesSharedWorkspaceRoot: true,
            repositoryPreparationOutcome: {
              mode: 'continued',
              workspaceType: workspace.type,
              totalRepositories: repositoriesToPrepare.length,
              preparedRepositoryCount: preparedRepositories.length,
              repositories: failedRepositories,
            },
          };
        }

        throw createWorkspaceRepositoryPreparationError({
          workspaceType: workspace.type,
          totalRepositories: repositoriesToPrepare.length,
          preparedRepositoryCount: preparedRepositories.length,
          failures: failedPreparations.map(({ result, repo }) => ({
            repository: repo ?? 'unknown repository',
            error: result.reason,
          })),
        });
      }

      const repoPaths = Object.fromEntries(
        preparedRepositories.map((result) => [
          result.repoName,
          result.repoPath,
        ]),
      );
      const repoLocalSkills = await discoverWorkspaceRepoLocalSkills({
        repoPaths,
        repoFullNamesByDir: Object.fromEntries(
          preparedRepositories.map((result) => [
            result.repoName,
            result.repoFullName,
          ]),
        ),
      });

      return {
        workspacePath: workspaceRoot,
        repoPaths,
        repoLocalSkills,
        usesSharedWorkspaceRoot: true,
      };
    }

    case 'repository': {
      let repoPath: string;

      try {
        repoPath = await timedStep(
          logger,
          `initializeRepositories: prepare ${workspace.repository}`,
          () =>
            workspaceManager.prepareRepository(
              workspace.repository,
              workspace.branch,
              workspace.sha,
              preserveGitState,
              cleanupLegacyPaths,
              sourceControlPrepareOptions,
            ),
        );
      } catch (error) {
        throw createWorkspaceRepositoryPreparationError({
          workspaceType: workspace.type,
          totalRepositories: 1,
          preparedRepositoryCount: 0,
          failures: [
            {
              repository: workspace.repository,
              error,
            },
          ],
        });
      }

      const repoName = workspace.repository;
      const repoPaths = { [repoName]: repoPath };
      const repoLocalSkills = await discoverWorkspaceRepoLocalSkills({
        repoPaths,
        repoFullNamesByDir: { [repoName]: workspace.repository },
      });

      return {
        workspacePath: workspaceRoot,
        repoPaths,
        repoLocalSkills,
        usesSharedWorkspaceRoot: true,
      };
    }
  }
}

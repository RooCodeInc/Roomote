import pLimit from 'p-limit';

import { DEFAULT_SOURCE_CONTROL_PROVIDER } from '@roomote/types';

import type { StartupLogger } from '../../../logging';
import {
  discoverClonedRepositoryPaths,
  writeRepositoriesManifest,
} from '../../../workspace/on-demand-repositories';
import { discoverRepoLocalSkills } from '../../../workspace/repo-local-skills';
import { listOnDemandRepositories } from './list-on-demand-repositories';

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
  return `${workspaceType} workspace`;
}

function pluralizeRepositories(count: number): string {
  return `${count} repositor${count === 1 ? 'y' : 'ies'}`;
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
 * Supports empty, single-repository, scoped multi-repository, all-repositories,
 * and environment workspaces.
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
    repositoryProviders,
  }: PrepareWorkspaceOptions,
): Promise<PrepareWorkspaceResult> {
  const resolvedSourceControlProvider =
    sourceControlProvider ?? DEFAULT_SOURCE_CONTROL_PROVIDER;
  const resolveRepositoryProvider = (repository: string) =>
    repositoryProviders?.[repository] ?? resolvedSourceControlProvider;
  const sourceControlPrepareOptions = (repository: string) => {
    const repositoryProvider = resolveRepositoryProvider(repository);

    return repositoryProvider === DEFAULT_SOURCE_CONTROL_PROVIDER
      ? {}
      : { sourceControlProvider: repositoryProvider };
  };
  const environmentSourceControlPrepareOptions = {
    ...(resolvedSourceControlProvider === DEFAULT_SOURCE_CONTROL_PROVIDER
      ? {}
      : { sourceControlProvider: resolvedSourceControlProvider }),
    ...(repositoryProviders ? { repositoryProviders } : {}),
  };
  const { workspaceRoot, workspaceManager } = createWorkspaceManager(
    envVars,
    logger,
  );

  // Git identity and the credential helper do not depend on any repository
  // being prepared: a Blank slate agent that clones a repository by hand
  // still needs an author to commit and a helper to push.
  await timedStep(logger, 'initializeRepositories: configure git', () =>
    workspaceManager.configure({ gitAuthorName, gitAuthorEmail }),
  );

  const prepareOnDemandWorkspace =
    async (): Promise<PrepareWorkspaceResult> => {
      // Checkouts left by a previous run (snapshot resume) are kept as-is.
      const onDemandRepositories = await timedStep(
        logger,
        'initializeRepositories: list repositories',
        () =>
          listOnDemandRepositories({
            sourceControlProvider: resolvedSourceControlProvider,
            repositoryProviders,
          }),
      );
      const repoPaths = discoverClonedRepositoryPaths(
        workspaceRoot,
        onDemandRepositories,
      );
      const clonedCount = Object.keys(repoPaths).length;

      writeRepositoriesManifest({
        workspaceRoot,
        repositories: onDemandRepositories,
        clonedPaths: repoPaths,
      });
      logger.userLog.info(
        `Indexed ${pluralizeRepositories(onDemandRepositories.length)} for on-demand checkout${
          clonedCount > 0
            ? ` (${pluralizeRepositories(clonedCount)} already checked out)`
            : ''
        }`,
      );

      const repoLocalSkills = await discoverWorkspaceRepoLocalSkills({
        repoPaths,
        repoFullNamesByDir: Object.fromEntries(
          Object.keys(repoPaths).map((fullName) => [fullName, fullName]),
        ),
      });

      return {
        workspacePath: workspaceRoot,
        repoPaths,
        repoLocalSkills,
        usesSharedWorkspaceRoot: true,
        onDemandRepositories,
      };
    };

  switch (workspace.type) {
    case 'no_repositories': {
      // A Blank slate starts with nothing checked out. When the launch
      // stamped a repository scope (the deployment has source control
      // connected), the agent can still check repositories out on demand
      // exactly like an all-repositories workspace; without a stamp the
      // sandbox needs no source-control credentials at all.
      if (Object.keys(repositoryProviders ?? {}).length === 0) {
        return {
          workspacePath: workspaceRoot,
          repoPaths: {},
          repoLocalSkills: [],
          usesSharedWorkspaceRoot: true,
        };
      }

      return prepareOnDemandWorkspace();
    }

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
            environmentSourceControlPrepareOptions,
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

    case 'all_repositories': {
      // An all-repositories workspace exposes every active repository, which
      // can be hundreds on a large installation. Cloning them all up front
      // made setup take minutes and a single stalled clone could wedge the
      // run, so the workspace root gets a manifest instead and the agent
      // checks out the repositories it needs through `clone_repository`.
      return prepareOnDemandWorkspace();
    }

    case 'repository_set': {
      const repositoriesToPrepare = workspace.repositories.map((fullName) => ({
        fullName,
      }));

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
                    ...sourceControlPrepareOptions(repo.fullName),
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
              sourceControlPrepareOptions(workspace.repository),
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

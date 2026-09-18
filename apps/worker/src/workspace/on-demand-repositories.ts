import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  LIST_REPOSITORIES_TOOL_NAME,
  type SourceControlProvider,
} from '@roomote/types';

/**
 * Markdown manifest written to the shared workspace root for tasks with an
 * authorized repository scope. It lists initial checkouts alongside optional
 * repositories the agent can check out with the `clone_repository` tool.
 */
export const ON_DEMAND_REPOSITORIES_MANIFEST_FILE = 'REPOSITORIES.md';

/**
 * Runtime env flag that tells the Roomote MCP server to expose the
 * `clone_repository` tool. Set whenever the run has authorized repositories
 * available beyond or instead of its initial workspace preparation.
 */
export const ON_DEMAND_REPOSITORIES_ENV_VAR = 'ROOMOTE_ON_DEMAND_REPOSITORIES';

export const CLONE_REPOSITORY_TOOL_NAME = 'clone_repository';

export function shouldRegisterCloneRepositoryTool(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ON_DEMAND_REPOSITORIES_ENV_VAR] === 'true';
}

export interface OnDemandRepository {
  fullName: string;
  sourceControlProvider: SourceControlProvider;
  defaultBranch: string;
  description: string | null;
  private: boolean;
}

const MAX_DESCRIPTION_LENGTH = 160;

/**
 * Resolve the checkout path for a repository full name and reject names that
 * would escape the workspace root. Full names are provider-synced, so a
 * hostile origin must never steer a path outside the workspace.
 */
export function resolveOnDemandRepositoryPath(
  workspaceRoot: string,
  fullName: string,
): string | undefined {
  const targetPath = join(workspaceRoot, fullName);
  const relativeToRoot = relative(workspaceRoot, targetPath);

  if (
    relativeToRoot === '' ||
    relativeToRoot.startsWith('..') ||
    isAbsolute(relativeToRoot)
  ) {
    return undefined;
  }

  return targetPath;
}

/**
 * Map every manifest repository that already has a git checkout under the
 * workspace root to its path. Covers snapshot resumes (clones from the
 * previous run survive) and manifest refreshes after a `clone_repository`
 * call.
 */
export function discoverClonedRepositoryPaths(
  workspaceRoot: string,
  repositories: readonly Pick<OnDemandRepository, 'fullName'>[],
): Record<string, string> {
  const repoPaths: Record<string, string> = {};

  for (const repository of repositories) {
    const repoPath = resolveOnDemandRepositoryPath(
      workspaceRoot,
      repository.fullName,
    );

    if (repoPath && existsSync(join(repoPath, '.git'))) {
      repoPaths[repository.fullName] = repoPath;
    }
  }

  return repoPaths;
}

/** Single-line, length-capped description for JSON tool output. */
function summarizeDescription(description: string | null): string {
  const singleLine = (description ?? '').replace(/\s+/g, ' ').trim();

  return singleLine.length <= MAX_DESCRIPTION_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function formatDescription(description: string | null): string {
  // Backslashes first: a raw `\|` would otherwise become `\\|`, which
  // Markdown reads as an escaped backslash followed by a live column break.
  const singleLine = (description ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();

  if (singleLine.length <= MAX_DESCRIPTION_LENGTH) {
    return singleLine;
  }

  return `${singleLine.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

/**
 * One page of the run's authorized repositories for the `list_repositories`
 * tool. Every whitespace-separated query term must appear in the full name or
 * the description, case-insensitively.
 */
export function pageOnDemandRepositories({
  repositories,
  clonedPaths,
  query,
  offset = 0,
  limit,
}: {
  repositories: readonly OnDemandRepository[];
  clonedPaths: Record<string, string>;
  query?: string;
  offset?: number;
  limit: number;
}) {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = repositories
    .filter((repository) => {
      const haystack =
        `${repository.fullName}\n${repository.description ?? ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (left, right) =>
        left.fullName.localeCompare(right.fullName) ||
        left.sourceControlProvider.localeCompare(right.sourceControlProvider),
    );
  const page = matches.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    repositories: page.map((repository) => {
      const description = summarizeDescription(repository.description);
      const path = clonedPaths[repository.fullName];
      return {
        fullName: repository.fullName,
        sourceControlProvider: repository.sourceControlProvider,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
        ...(description ? { description } : {}),
        checkedOut: Boolean(path),
        ...(path ? { path } : {}),
      };
    }),
    totalCount: matches.length,
    ...(page.length > 0 && nextOffset < matches.length ? { nextOffset } : {}),
  };
}

export function buildRepositoriesManifest({
  workspaceRoot,
  repositories,
  clonedPaths,
}: {
  workspaceRoot: string;
  repositories: readonly OnDemandRepository[];
  clonedPaths: Record<string, string>;
}): string {
  const sorted = [...repositories].sort((left, right) => {
    const leftCloned = left.fullName in clonedPaths ? 0 : 1;
    const rightCloned = right.fullName in clonedPaths ? 0 : 1;

    return (
      leftCloned - rightCloned || left.fullName.localeCompare(right.fullName)
    );
  });
  const clonedCount = sorted.filter(
    (repository) => repository.fullName in clonedPaths,
  ).length;

  const lines = [
    '# Repositories',
    '',
    'This file is generated by Roomote for the current task and is rewritten when a repository is checked out.',
    `${repositories.length} ${repositories.length === 1 ? 'repository is' : 'repositories are'} available to this task; ${clonedCount} ${clonedCount === 1 ? 'is' : 'are'} checked out.`,
    '',
    `Repositories marked "no" are not cloned up front. Call the \`${CLONE_REPOSITORY_TOOL_NAME}\` tool with \`repositoryFullName\` (for example \`${sorted[0]?.fullName ?? 'owner/repo'}\`) to check one out; it is cloned into \`${join(workspaceRoot, '<owner>', '<repo>')}\` and the tool returns the path. Only checked-out repositories exist on disk. Do not run \`git clone\` yourself.`,
    '',
    `This file is a snapshot. The \`${LIST_REPOSITORIES_TOOL_NAME}\` tool reads the same repositories live and can search them by name or description.`,
    '',
    '| Repository | Checked out | Default branch | Visibility | Description |',
    '| --- | --- | --- | --- | --- |',
    ...sorted.map((repository) => {
      const repoPath = clonedPaths[repository.fullName];

      return `| \`${repository.fullName}\` | ${repoPath ? `yes (\`${repoPath}\`)` : 'no'} | \`${repository.defaultBranch}\` | ${repository.private ? 'private' : 'public'} | ${formatDescription(repository.description)} |`;
    }),
    '',
  ];

  return lines.join('\n');
}

export function writeRepositoriesManifest({
  workspaceRoot,
  repositories,
  clonedPaths,
}: {
  workspaceRoot: string;
  repositories: readonly OnDemandRepository[];
  clonedPaths: Record<string, string>;
}): string {
  mkdirSync(workspaceRoot, { recursive: true });

  const manifestPath = join(
    workspaceRoot,
    ON_DEMAND_REPOSITORIES_MANIFEST_FILE,
  );

  writeFileSync(
    manifestPath,
    buildRepositoriesManifest({ workspaceRoot, repositories, clonedPaths }),
    'utf8',
  );

  return manifestPath;
}

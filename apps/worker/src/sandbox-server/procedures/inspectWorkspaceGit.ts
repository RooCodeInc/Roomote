import fs from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import type { WorkspaceGitManifest } from '@roomote/types';

import { publicProcedure } from '../trpc';

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
]);

async function findRepositories(root: string): Promise<string[]> {
  const repositories: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === '.git')) {
      repositories.push(directory);
      return;
    }
    if (depth >= 3) return;

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !SKIP_DIRECTORIES.has(entry.name) &&
            !entry.name.startsWith('.'),
        )
        .map((entry) => visit(path.join(directory, entry.name), depth + 1)),
    );
  }

  await visit(root, 0);
  return repositories.sort();
}

async function git(
  cwd: string,
  args: string[],
  options: { preserveLeadingWhitespace?: boolean } = {},
): Promise<string | null> {
  const result = await execa('git', args, { cwd, reject: false });
  const stdout = options.preserveLeadingWhitespace
    ? result.stdout.trimEnd()
    : result.stdout.trim();
  return result.exitCode === 0 ? stdout || null : null;
}

export const inspectWorkspaceGit = publicProcedure.query(
  async ({ ctx }): Promise<WorkspaceGitManifest> => {
    const repositoryPaths = await findRepositories(ctx.workingDirectory);
    const repositories = await Promise.all(
      repositoryPaths.map(async (repositoryPath) => {
        const status = await git(repositoryPath, ['status', '--porcelain=v1'], {
          preserveLeadingWhitespace: true,
        });
        const upstream = await git(repositoryPath, [
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{upstream}',
        ]);
        const counts = upstream
          ? await git(repositoryPath, [
              'rev-list',
              '--left-right',
              '--count',
              `${upstream}...HEAD`,
            ])
          : null;
        const [behind = 0, ahead = 0] = (counts ?? '')
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10) || 0);

        return {
          repository:
            path.relative(ctx.workingDirectory, repositoryPath) || '.',
          branch: await git(repositoryPath, ['branch', '--show-current']),
          headSha: await git(repositoryPath, ['rev-parse', 'HEAD']),
          upstream,
          ahead,
          behind,
          dirtyPaths: (status ?? '')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.slice(3)),
        };
      }),
    );

    return { repositories, inspectedAt: new Date().toISOString() };
  },
);

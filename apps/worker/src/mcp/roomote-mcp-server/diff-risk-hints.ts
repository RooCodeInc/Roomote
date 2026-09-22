import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getRoomoteConfig } from './config.js';
import { getDiffRiskHints } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** The server caps the diff it screens; send no more than it accepts. */
const MAX_DIFF_CHARS = 400_000;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_FILE_BYTES = 200_000;

function git(
  cwd: string,
  args: string[],
  allowExitCodes: number[] = [],
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        const code =
          error && typeof error.code === 'number' ? error.code : null;
        resolvePromise(
          error && !(code !== null && allowExitCodes.includes(code))
            ? null
            : stdout,
        );
      },
    );
  });
}

/**
 * What this branch changes against the default branch, as a pull request
 * would show it, plus uncommitted and untracked work so the agent can screen
 * before it commits.
 */
export async function collectBranchDiff(
  repositoryPath: string,
): Promise<string | null> {
  const base =
    (
      await git(repositoryPath, ['merge-base', 'HEAD', 'origin/HEAD'])
    )?.trim() ||
    (
      await git(repositoryPath, ['rev-parse', '--verify', '-q', 'HEAD~1'])
    )?.trim();

  if (!base) {
    return null;
  }

  const tracked = await git(repositoryPath, ['diff', '--no-color', base]);

  if (tracked === null) {
    return null;
  }

  const untracked = (
    (await git(repositoryPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])) ?? ''
  )
    .split('\0')
    .filter((file) => {
      if (!file) return false;
      try {
        const stats = statSync(join(repositoryPath, file));
        return stats.isFile() && stats.size <= MAX_UNTRACKED_FILE_BYTES;
      } catch {
        return false;
      }
    })
    .slice(0, MAX_UNTRACKED_FILES);
  const untrackedPatches = await Promise.all(
    untracked.map((file) =>
      // `--no-index` exits 1 whenever the files differ, which is always here.
      git(
        repositoryPath,
        ['diff', '--no-color', '--no-index', '--', '/dev/null', file],
        [1],
      ),
    ),
  );

  return [tracked, ...untrackedPatches.filter(Boolean)].join('');
}

export async function handleGetDiffRiskHints(input: {
  repositoryPath?: string;
}): Promise<ToolResult> {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);

  if (!Number.isInteger(runId) || runId <= 0) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  const config = getRoomoteConfig();

  if (!config) {
    return errorResult('Roomote platform credentials are not available');
  }

  const repositoryPath = resolve(
    input.repositoryPath?.trim() || process.env.ROOMOTE_WORKSPACE_PATH || '.',
  );

  try {
    const diff = await collectBranchDiff(repositoryPath);

    if (diff === null) {
      return errorResult(
        `Could not compute a diff in ${repositoryPath}. Pass repositoryPath pointing at the git checkout you changed.`,
      );
    }

    if (!diff.trim()) {
      return successResult({
        available: false,
        reason: 'This branch has no changes against the default branch.',
      });
    }

    const result = await getDiffRiskHints(
      config,
      runId,
      diff.slice(0, MAX_DIFF_CHARS),
    );

    return successResult({ ...result });
  } catch (error) {
    return catchError(error);
  }
}

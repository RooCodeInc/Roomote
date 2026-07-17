import * as path from 'path';

import { execa, type ExecaError } from 'execa';

import type { CommandExecutionResult, StreamChunk } from '../types';

import { DEFAULT_COMMAND_TIMEOUT } from '../trpc';

interface ExecuteOptions {
  /** Working directory */
  cwd: string;

  /** Timeout in milliseconds */
  timeout?: number;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

interface ExecuteStreamOptions extends ExecuteOptions {
  /** Callback for each output chunk */
  onChunk: (chunk: StreamChunk) => void;
}

/** Handle returned by executeStream for controlling the subprocess */
export interface StreamHandle {
  /** Promise that resolves when the command completes */
  promise: Promise<void>;

  /** Kill the subprocess */
  kill: () => void;
}

export interface GitRepo {
  /** Directory name of the repo (or '.' for root-level repos) */
  name: string;

  /** Absolute path to the repo directory (parent of .git) */
  path: string;
}

export class CommandExecutor {
  /**
   * Execute 'git diff' against an optional base SHA and return the result.
   * When no baseSha is provided, diffs against the working tree.
   */
  static async gitDiff(
    options: ExecuteOptions & { baseSha?: string },
  ): Promise<CommandExecutionResult> {
    const args = options.baseSha
      ? ['git', 'diff', options.baseSha]
      : ['git', 'diff'];

    return this.runCommand(args as [string, ...string[]], options);
  }

  /**
   * Run 'git add --intent-to-add .' to mark untracked files so they
   * appear in subsequent git diff output.
   */
  static async gitAddIntentToAdd(
    options: ExecuteOptions,
  ): Promise<CommandExecutionResult> {
    return this.runCommand(['git', 'add', '--intent-to-add', '.'], options);
  }

  /**
   * Discover git repos in the workspace root, direct child repos, or
   * owner/repo-nested repos under a shared workspace root.
   * Returns an array of { name, path } where name is the repo directory
   * name (or '.' for a root-level repo) and path is the absolute path
   * to the repo directory.
   */
  static async gitFindRepos(options: ExecuteOptions): Promise<GitRepo[]> {
    const result = await this.runCommand(
      ['find', options.cwd, '-maxdepth', '3', '-name', '.git', '-type', 'd'],
      options,
    );

    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((gitDir) => {
        const repoDir = path.dirname(gitDir);
        const relative = path.relative(options.cwd, repoDir);
        const name = relative === '' ? '.' : relative;
        return { name, path: repoDir };
      });
  }

  /**
   * Stream 'tail -f' output on a file (follows new content).
   * Validates the path to prevent injection and traversal attacks.
   */
  static tailStream(
    filePath: string,
    options: ExecuteStreamOptions,
  ): StreamHandle {
    if (!filePath) {
      throw new Error('Path cannot be empty');
    }

    // Confine tails to paths under the working directory. Absolute paths
    // would otherwise bypass the ".."-only check and read host files.
    if (path.isAbsolute(filePath)) {
      throw new Error('Absolute paths are not allowed');
    }

    if (filePath.includes('..')) {
      throw new Error('Path traversal not allowed');
    }

    if (/[;`$|&<>(){}]/.test(filePath)) {
      throw new Error('Invalid characters in path');
    }

    return this.runCommandStream(['tail', '-f', '--', filePath], options);
  }

  /**
   * Internal: Execute a command with an args array (no shell).
   */
  private static async runCommand(
    args: [string, ...string[]],
    options: ExecuteOptions,
  ): Promise<CommandExecutionResult> {
    const { cwd, timeout = DEFAULT_COMMAND_TIMEOUT, signal } = options;
    const startTime = Date.now();
    const [command, ...commandArgs] = args;

    try {
      const result = await execa(command, commandArgs, {
        cwd,
        timeout,
        reject: false,
        cancelSignal: signal,
      });

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode ?? 0,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        duration: Date.now() - startTime,
      };
    } catch (e) {
      const execaError = e as ExecaError;

      return {
        success: false,
        exitCode: execaError.exitCode ?? 1,
        stdout: typeof execaError.stdout === 'string' ? execaError.stdout : '',
        stderr: typeof execaError.stderr === 'string' ? execaError.stderr : '',
        duration: Date.now() - startTime,
        error: execaError.message,
      };
    }
  }

  /**
   * Internal: Execute a command with streaming output (no shell).
   */
  private static runCommandStream(
    args: [string, ...string[]],
    options: ExecuteStreamOptions,
  ): StreamHandle {
    const { cwd, timeout = DEFAULT_COMMAND_TIMEOUT, signal, onChunk } = options;
    const [command, ...commandArgs] = args;

    const subprocess = execa(command, commandArgs, {
      cwd,
      timeout,
      reject: false,
      cancelSignal: signal,
    });

    subprocess.stdout?.on('data', (data: Buffer) => {
      onChunk({ type: 'stdout', data: data.toString(), timestamp: new Date() });
    });

    subprocess.stderr?.on('data', (data: Buffer) => {
      onChunk({ type: 'stderr', data: data.toString(), timestamp: new Date() });
    });

    const promise = subprocess
      .then((result) => {
        onChunk({
          type: 'exit',
          exitCode: result.exitCode,
          timestamp: new Date(),
        });
      })
      .catch((e: ExecaError) => {
        onChunk({
          type: e.timedOut ? 'timeout' : 'exit',
          exitCode: e.exitCode ?? 1,
          timestamp: new Date(),
        });
      });

    return { promise, kill: () => subprocess.kill() };
  }
}

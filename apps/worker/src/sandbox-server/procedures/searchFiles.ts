import * as path from 'path';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { execa } from 'execa';

import { captureWorkerException } from '../../monitoring/sentry';

import type { FileSearchResponse, FileSearchResult } from '../types';

import { publicProcedure } from '../trpc';

// Directories to exclude from search.
const EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
];

/**
 * List all files in the working directory using ripgrep, excluding common
 * noise directories.
 */
async function listFiles(cwd: string): Promise<string[]> {
  const excludeArgs = EXCLUDED_DIRS.flatMap((dir) => ['-g', `!${dir}/**`]);
  const result = await execa('rg', ['--files', ...excludeArgs], {
    cwd,
    reject: false,
  });

  if (result.exitCode === undefined) {
    throw new Error('ripgrep (rg) is not installed');
  }

  // An exit code of 1 means no matches (fine), and other non-zero values are
  // real errors.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    console.error('[searchFiles] rg failed', {
      exitCode: result.exitCode,
      stderr: result.stderr || '(empty)',
      cwd,
    });

    throw new Error(
      `rg failed (exit ${result.exitCode}): ${result.stderr || 'no stderr'}`,
    );
  }

  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Extract unique directory paths from a list of file paths.
 * For each file, all ancestor directories are collected (e.g. "src/utils/helpers.ts"
 * yields "src" and "src/utils").
 */
export function extractDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();

  for (const filePath of filePaths) {
    let dir = path.dirname(filePath);

    while (dir !== '.') {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  return Array.from(dirs).sort();
}

/**
 * Search for files and directories by name within the working directory.
 * Requires ripgrep (rg) to be installed.
 */
export const searchFiles = publicProcedure
  .input(
    z.object({
      /** Search query (matches against file/directory paths) */
      query: z.string().min(1).max(100),
      /** Maximum number of results to return */
      maxResults: z.number().min(1).max(50).default(20),
    }),
  )
  .query(async ({ ctx, input }): Promise<FileSearchResponse> => {
    const { workingDirectory } = ctx;
    const { query, maxResults } = input;

    try {
      const allFiles = await listFiles(workingDirectory);
      const allDirs = extractDirectories(allFiles);
      const queryLower = query.toLowerCase();

      const matchingDirs: FileSearchResult[] = allDirs
        .filter((dirPath) => dirPath.toLowerCase().includes(queryLower))
        .map((dirPath) => ({
          path: dirPath,
          name: path.basename(dirPath),
          type: 'directory' as const,
        }));

      const matchingFiles: FileSearchResult[] = allFiles
        .filter((filePath) => filePath.toLowerCase().includes(queryLower))
        .map((filePath) => ({
          path: filePath,
          name: path.basename(filePath),
          type: 'file' as const,
        }));

      // Directories first, then files.
      const allResults = [...matchingDirs, ...matchingFiles];
      const truncated = allResults.length > maxResults;
      const results = allResults.slice(0, maxResults);

      return { query, results, truncated };
    } catch (error) {
      captureWorkerException(error, {
        query,
        stage: 'searchFiles.query',
        workingDirectory,
      });
      console.error('[searchFiles] error', {
        query,
        workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to search files: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { StreamChunk } from '../../types';

import { CommandExecutor } from '../command-executor';

describe('CommandExecutor', () => {
  const testCwd = process.cwd();

  describe('gitDiff', () => {
    it('should execute git diff', async () => {
      const result = await CommandExecutor.gitDiff({ cwd: testCwd });

      expect(result.exitCode).toBeDefined();
      expect(result.duration).toBeGreaterThan(0);
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
    });
  });

  describe('gitFindRepos', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-executor-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('finds owner/repo-nested repos from a shared workspace root', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'direct-repo', '.git'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(tmpDir, 'Roomote', 'Roomote', '.git'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(tmpDir, 'too', 'deep', 'repo', '.git'), {
        recursive: true,
      });

      const repos = await CommandExecutor.gitFindRepos({ cwd: tmpDir });

      expect(
        [...repos]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((repo) => ({
            name: repo.name,
            path: path.relative(tmpDir, repo.path) || '.',
          })),
      ).toEqual([
        { name: '.', path: '.' },
        { name: 'direct-repo', path: 'direct-repo' },
        { name: 'Roomote/Roomote', path: 'Roomote/Roomote' },
      ]);
    });
  });

  describe('tailStream', () => {
    it('should stream tail output and can be killed', async () => {
      const chunks: StreamChunk[] = [];

      const handle = CommandExecutor.tailStream('package.json', {
        cwd: testCwd,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // Wait for initial output (tail -f outputs last 10 lines immediately).
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have received stdout.
      const stdoutChunks = chunks.filter((c) => c.type === 'stdout');
      expect(stdoutChunks.length).toBeGreaterThan(0);

      // Kill the process.
      handle.kill();
      await handle.promise;

      // Should have exit chunk after kill.
      const exitChunk = chunks.find((c) => c.type === 'exit');
      expect(exitChunk).toBeDefined();
    });

    it('should reject empty path', () => {
      expect(() =>
        CommandExecutor.tailStream('', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Path cannot be empty');
    });

    it('should reject path traversal', () => {
      expect(() =>
        CommandExecutor.tailStream('../etc/passwd', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Path traversal not allowed');
    });

    it('should reject shell metacharacters in path', () => {
      expect(() =>
        CommandExecutor.tailStream('file;rm -rf /', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Invalid characters in path');
    });

    it('should reject command substitution in path', () => {
      expect(() =>
        CommandExecutor.tailStream('$(whoami)', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Invalid characters in path');
    });

    it('should reject backticks in path', () => {
      expect(() =>
        CommandExecutor.tailStream('`whoami`', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Invalid characters in path');
    });

    it('should reject pipes in path', () => {
      expect(() =>
        CommandExecutor.tailStream('file|cat', {
          cwd: testCwd,
          onChunk: () => {},
        }),
      ).toThrow('Invalid characters in path');
    });

    it('should allow subdirectory paths', async () => {
      const chunks: StreamChunk[] = [];

      const handle = CommandExecutor.tailStream('src/index.ts', {
        cwd: testCwd,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // Wait for initial output.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Kill and wait for exit.
      handle.kill();
      await handle.promise;

      const exitChunk = chunks.find((c) => c.type === 'exit');
      expect(exitChunk).toBeDefined();
    });
  });
});

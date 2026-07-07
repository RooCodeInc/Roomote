// pnpm --filter @roomote/worker test src/command-executor/__tests__/command-executor.test.ts

import type { Command } from '@roomote/types';

import {
  buildPm2ProcessName,
  buildPm2StartArgs,
  CommandExecutor,
  ExecutionError,
  findStalePm2ProcessNames,
} from '../command-executor';

describe('CommandExecutor', () => {
  const mockRepoPath = '/tmp';
  const mockEnv = { TEST_VAR: 'test_value' };

  it('should execute a successful command', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Test Command',
      run: 'echo "Hello World"',
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.command).toBe(command);
    expect(result.stdout).toContain('Hello World');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should throw ExecutionError on command failure', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Failing Command',
      run: 'exit 1',
      timeout: 5,
      continue_on_error: false,
    };

    const error = await executor.execute(command).catch((e) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.result.success).toBe(false);
    expect(error.result.command).toBe(command);
    expect(error.result.duration).toBeGreaterThan(0);
  });

  it('should include the underlying error summary in formatted execution details', () => {
    const command: Command = {
      name: 'Timeout Command',
      run: 'git reset --hard HEAD',
      timeout: 60,
      continue_on_error: false,
    };

    const error = new ExecutionError('Command timed out', {
      command,
      success: false,
      duration: 60_000,
      error: 'Command timed out after 60 seconds: git reset --hard HEAD',
      stdout: '',
      stderr: '',
    });

    expect(error.formatDetails()).toContain(
      'error -> Command timed out after 60 seconds: git reset --hard HEAD',
    );
  });

  it('should respect continue_on_error flag', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const commands: Command[] = [
      {
        name: 'Failing Command',
        run: 'exit 1',
        timeout: 5,
        continue_on_error: true,
      },
      {
        name: 'Success Command',
        run: 'echo "Still running"',
        timeout: 5,
        continue_on_error: false,
      },
    ];

    const results = await executor.executeAll(commands);
    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(false);
    expect(results[1]?.success).toBe(true);
  });

  it('should stop execution on failure when continue_on_error is false', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const commands: Command[] = [
      {
        name: 'Failing Command',
        run: 'exit 1',
        timeout: 5,
        continue_on_error: false,
      },
      {
        name: 'Should Not Run',
        run: 'echo "Should not see this"',
        timeout: 5,
        continue_on_error: false,
      },
    ];

    const error = await executor.executeAll(commands).catch((e) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.result.success).toBe(false);
  });

  it('should merge environment variables', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Env Test',
      run: 'echo "$TEST_VAR $CUSTOM_VAR"',
      env: { CUSTOM_VAR: 'custom_value' },
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('test_value custom_value');
  });

  it('should not inherit ambient process env vars', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);
    const originalAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'production';

    try {
      const command: Command = {
        name: 'Ambient Env Leak Test',
        run: 'printf "%s" "${APP_ENV:-missing}"',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('missing');
    } finally {
      if (originalAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = originalAppEnv;
      }
    }
  });

  it('should close stdin for commands so interactive prompts cannot hang', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Stdin Ignored Test',
      run: 'if read -t 1 _input; then echo "unexpected input"; else echo "stdin closed"; fi',
      timeout: 2,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('stdin closed');
  });

  it('should execute multi-line commands as separate commands', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Multi-line Test',
      run: `echo "First command"
            echo "Second command"
            echo "Third command"`,
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('First command');
    expect(result.stdout).toContain('Second command');
    expect(result.stdout).toContain('Third command');
    expect(result.stdout?.split('\n')).toHaveLength(3);
  });

  it('should stop multi-line execution on first failure', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Failing Multi-line',
      run: `echo "First command"
            exit 1
            echo "Should not execute"`,
      timeout: 5,
      continue_on_error: false,
    };

    const error = await executor.execute(command).catch((e) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.result.stdout).toContain('First command');
    expect(error.result.stdout).not.toContain('Should not execute');
  });

  it('should retry a failing command line when retries are configured', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);
    const sleepSpy = vi
      .spyOn(
        executor as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const markerPath = `/tmp/command-executor-retry-${Date.now()}`;

    try {
      const command: Command = {
        name: 'Retry Test',
        run: `if [ -f "${markerPath}" ]; then echo "Recovered"; else touch "${markerPath}" && exit 1; fi`,
        retries: 1,
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Recovered');
      expect(sleepSpy).toHaveBeenCalledWith(1000);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Retry Test] Attempt 1/2 failed. Exit code: 1. Retrying in 1000ms...',
      );
      expect(warnSpy.mock.calls[0]?.[0]).not.toContain(markerPath);
      expect(warnSpy.mock.calls[0]?.[0]).not.toContain('touch');
    } finally {
      await executor.execute({
        name: 'Cleanup retry marker',
        run: `rm -f "${markerPath}"`,
        timeout: 5,
        continue_on_error: true,
      });

      warnSpy.mockRestore();
    }
  });

  it('should retry only the failing line in a multi-line command', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);
    const sleepSpy = vi
      .spyOn(
        executor as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);
    const retryMarkerPath = `/tmp/command-executor-retry-marker-${Date.now()}`;
    const lineCountPath = `/tmp/command-executor-line-count-${Date.now()}`;

    try {
      const command: Command = {
        name: 'Multi-line Retry Test',
        run: `echo "First line" >> "${lineCountPath}"
if [ -f "${retryMarkerPath}" ]; then echo "Second line recovered"; else touch "${retryMarkerPath}" && exit 1; fi
echo "Third line"`,
        retries: 1,
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      const countResult = await executor.execute({
        name: 'Read multi-line retry counter',
        run: `cat "${lineCountPath}"`,
        timeout: 5,
        continue_on_error: false,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Second line recovered');
      expect(result.stdout).toContain('Third line');
      expect(countResult.stdout?.trim()).toBe('First line');
      expect(sleepSpy).toHaveBeenCalledWith(1000);
    } finally {
      await executor.execute({
        name: 'Cleanup multi-line retry files',
        run: `rm -f "${retryMarkerPath}" "${lineCountPath}"`,
        timeout: 5,
        continue_on_error: true,
      });
    }
  });

  it('should join backslash-continued lines into a single command', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Continuation Test',
      run: `echo "hello" && \\\necho "world"`,
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('world');
    // Both echoes run as a single command via &&, so output is two lines.
    expect(result.stdout?.split('\n')).toHaveLength(2);
  });

  it('should join multi-line env var assignments with backslash continuations', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Env Continuation Test',
      run: `FOO=foo \\\n  BAR=bar \\\n  bash -c 'echo "$FOO $BAR"'`,
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('foo bar');
  });

  it('should handle continuation lines mixed with regular multi-line commands', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Mixed Continuation Test',
      run: `echo "first"\necho "second" && \\\necho "third"\necho "fourth"`,
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
    expect(result.stdout).toContain('third');
    expect(result.stdout).toContain('fourth');
  });

  it('should run detached commands in the background', async () => {
    const executor = new CommandExecutor('/tmp', mockEnv);

    const command: Command = {
      name: 'Detached Test',
      run: 'echo "background"',
      timeout: 5,
      continue_on_error: false,
      detached: true,
      logfile: '/tmp/detached-executor-test.log',
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
  });

  it('should throw when detached command fails to start', async () => {
    const executor = new CommandExecutor('/tmp', mockEnv);

    const command: Command = {
      name: 'Detached Fail Test',
      run: '/nonexistent/binary --flag',
      timeout: 5,
      continue_on_error: false,
      detached: true,
    };

    await expect(executor.execute(command)).rejects.toThrow(
      'Detached command failed to start',
    );
  });

  it('should filter out comment lines with or without leading whitespace', async () => {
    const executor = new CommandExecutor(mockRepoPath, mockEnv);

    const command: Command = {
      name: 'Comment Test',
      run: `echo "First command"
            # This is a comment without leading space
              # This is a comment with leading spaces
            echo "Second command"
            	# This is a comment with leading tab
            echo "Third command"`,
      timeout: 5,
      continue_on_error: false,
    };

    const result = await executor.execute(command);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('First command');
    expect(result.stdout).toContain('Second command');
    expect(result.stdout).toContain('Third command');
    expect(result.stdout).not.toContain('comment');
    expect(result.stdout?.split('\n')).toHaveLength(3);
  });

  describe('YAML block scalar support', () => {
    it('should handle YAML | (literal block scalar) format with trailing newline', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // YAML `|` produces a multi-line string with a trailing newline:
      // run: |
      //   echo "first"
      //   echo "second"
      // -> "echo \"first\"\necho \"second\"\n"
      const command: Command = {
        name: 'YAML literal block scalar',
        run: 'echo "first"\necho "second"\n',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });

    it('should handle YAML |- (strip trailing newline) format', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // YAML `|-` strips the trailing newline:
      // run: |-
      //   echo "first"
      //   echo "second"
      // -> "echo \"first\"\necho \"second\""
      const command: Command = {
        name: 'YAML strip block scalar',
        run: 'echo "first"\necho "second"',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });

    it('should handle YAML |+ (keep trailing newlines) format', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // YAML `|+` keeps all trailing newlines:
      // run: |+
      //   echo "first"
      //   echo "second"
      //
      // -> "echo \"first\"\necho \"second\"\n\n"
      const command: Command = {
        name: 'YAML keep block scalar',
        run: 'echo "first"\necho "second"\n\n',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });

    it('should handle YAML | with backslash continuations', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // YAML `|` with backslash continuations:
      // run: |
      //   echo "hello" && \
      //   echo "world"
      // -> "echo \"hello\" && \\\necho \"world\"\n"
      const command: Command = {
        name: 'YAML block with continuations',
        run: 'echo "hello" && \\\necho "world"\n',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello');
      expect(result.stdout).toContain('world');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });

    it('should handle YAML | with comments interspersed', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // YAML `|` with comments:
      // run: |
      //   echo "first"
      //   # this is a comment
      //   echo "second"
      // -> "echo \"first\"\n# this is a comment\necho \"second\"\n"
      const command: Command = {
        name: 'YAML block with comments',
        run: 'echo "first"\n# this is a comment\necho "second"\n',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout).not.toContain('comment');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });

    it('should handle YAML | with mixed empty lines', async () => {
      const executor = new CommandExecutor(mockRepoPath, mockEnv);

      // Users sometimes add blank lines for readability in YAML:
      // run: |
      //   echo "first"
      //
      //   echo "second"
      // -> "echo \"first\"\n\necho \"second\"\n"
      const command: Command = {
        name: 'YAML block with empty lines',
        run: 'echo "first"\n\necho "second"\n',
        timeout: 5,
        continue_on_error: false,
      };

      const result = await executor.execute(command);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout?.split('\n')).toHaveLength(2);
    });
  });
});

describe('PM2 detached command helpers', () => {
  it('builds stable process names from command identity and cwd', () => {
    const first = buildPm2ProcessName({
      commandName: 'Start Web App',
      cmdLine: 'pnpm dev',
      cwd: '/workspace/repos/acme/web',
    });
    const second = buildPm2ProcessName({
      commandName: 'Start Web App',
      cmdLine: 'pnpm dev',
      cwd: '/workspace/repos/acme/web',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^roomote-web-start-web-app-[a-f0-9]{10}$/);
  });

  it('runs detached commands as foreground bash commands under PM2 supervision', () => {
    expect(
      buildPm2StartArgs({
        processName: 'roomote-web-start-web-app-1234567890',
        cmdLine: 'pnpm dev',
        cwd: '/workspace/repos/acme/web',
        logfile: '/tmp/web.log',
      }),
    ).toEqual([
      'start',
      '/bin/bash',
      '--name',
      'roomote-web-start-web-app-1234567890',
      '--cwd',
      '/workspace/repos/acme/web',
      '--time',
      '--log',
      '/tmp/web.log',
      '--restart-delay',
      '1000',
      '--max-restarts',
      '1000',
      '--',
      '-lc',
      'pnpm dev',
    ]);
  });

  it('finds stale managed PM2 processes for the repo before setup reruns', () => {
    expect(
      findStalePm2ProcessNames({
        desiredProcessNames: new Set(['roomote-web-start-web-app-1234567890']),
        processes: [
          {
            name: 'roomote-web-start-web-app-1234567890',
            pm2_env: { pm_cwd: '/workspace/repos/acme/web' },
          },
          {
            name: 'roomote-web-old-web-app-0987654321',
            pm2_env: { pm_cwd: '/workspace/repos/acme/web' },
          },
          {
            name: 'roomote-other-service-5555555555',
            pm2_env: { pm_cwd: '/workspace/repos/other/service' },
          },
          {
            name: 'my-manual-pm2-process',
            pm2_env: { pm_cwd: '/workspace/repos/acme/web' },
          },
        ],
        repoRoot: '/workspace/repos/acme',
      }),
    ).toEqual(['roomote-web-old-web-app-0987654321']);
  });
});

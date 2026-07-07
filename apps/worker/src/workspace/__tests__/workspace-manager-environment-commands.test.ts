// pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/workspace/__tests__/workspace-manager-environment-commands.test.ts

import { WorkspaceManager } from '../workspace-manager';
import type { ExecutionResult } from '../../command-executor';

const { MockExecutionError, mockExecuteAll } = vi.hoisted(() => ({
  MockExecutionError: class ExecutionError extends Error {
    constructor(
      message: string,
      public readonly result: ExecutionResult,
    ) {
      super(message);
      this.name = 'ExecutionError';
    }
  },
  mockExecuteAll: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: vi.fn(),
    },
  },
}));

vi.mock('../../lib/github-token', () => ({
  ensureGitCredentialHelper: vi
    .fn()
    .mockReturnValue('/tmp/git-credential-roomote.sh'),
}));

vi.mock('../../command-executor', () => ({
  CommandExecutor: vi.fn().mockImplementation(function () {
    return {
      executeAll: mockExecuteAll,
    };
  }),
  ExecutionError: MockExecutionError,
}));

const repoPath = '/workspace/backend';

function createCommand(params: { name: string; continueOnError: boolean }) {
  return {
    name: params.name,
    run: `echo ${JSON.stringify(params.name)}`,
    timeout: 600,
    continue_on_error: params.continueOnError,
  };
}

function createFailureResult(command: {
  name: string;
  run: string;
  timeout: number;
  continue_on_error: boolean;
}): ExecutionResult {
  return {
    command,
    success: false,
    duration: 42,
    exitCode: 1,
    stdout: '',
    stderr: `${command.name} stderr`,
    error: `Command failed with exit code 1`,
  };
}

describe('WorkspaceManager environment repository commands', () => {
  let manager: WorkspaceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorkspaceManager('/workspace', {} as NodeJS.ProcessEnv);
  });

  it('reports a required command failure and continues remaining commands when continueOnError is enabled', async () => {
    const commands = [
      createCommand({ name: 'Install deps', continueOnError: false }),
      createCommand({ name: 'Start dev server', continueOnError: false }),
    ];
    const onCommandFailure = vi.fn();
    const executedCommands: string[] = [];

    mockExecuteAll.mockImplementationOnce(async (inputCommands, options) => {
      for (const command of inputCommands) {
        executedCommands.push(command.name);
        options.onStart?.(command);

        if (command.name === 'Install deps') {
          const error = new MockExecutionError(
            'Command failed with exit code 1',
            createFailureResult(command),
          );

          if (!options.continueOnExecutionError) {
            throw error;
          }

          options.onResult?.(error.result);
          continue;
        }

        options.onResult?.({
          command,
          success: true,
          duration: 10,
          stdout: 'ok',
          stderr: '',
        });
      }

      return [];
    });

    await manager.executeEnvironmentRepositoryCommands(
      [{ repository: 'acme/backend', commands }],
      { 'acme/backend': repoPath },
      undefined,
      { continueOnError: true, onCommandFailure },
    );

    expect(executedCommands).toEqual(['Install deps', 'Start dev server']);
    expect(mockExecuteAll).toHaveBeenCalledWith(commands, {
      onStart: expect.any(Function),
      onResult: expect.any(Function),
      continueOnExecutionError: true,
    });
    expect(onCommandFailure).toHaveBeenCalledWith({
      repository: 'acme/backend',
      result: expect.objectContaining({
        command: expect.objectContaining({
          name: 'Install deps',
          continue_on_error: false,
        }),
        success: false,
      }),
    });
  });

  it('reports an optional command failure and continues when continueOnError is enabled', async () => {
    const commands = [
      createCommand({ name: 'Install deps', continueOnError: true }),
      createCommand({ name: 'Start dev server', continueOnError: false }),
    ];
    const onCommandFailure = vi.fn();

    mockExecuteAll.mockImplementationOnce(async (inputCommands, options) => {
      for (const command of inputCommands) {
        options.onStart?.(command);
        options.onResult?.(
          command.name === 'Install deps'
            ? createFailureResult(command)
            : {
                command,
                success: true,
                duration: 10,
                stdout: 'ok',
                stderr: '',
              },
        );
      }

      return [];
    });

    await manager.executeEnvironmentRepositoryCommands(
      [{ repository: 'acme/backend', commands }],
      { 'acme/backend': repoPath },
      undefined,
      { continueOnError: true, onCommandFailure },
    );

    expect(onCommandFailure).toHaveBeenCalledWith({
      repository: 'acme/backend',
      result: expect.objectContaining({
        command: expect.objectContaining({
          name: 'Install deps',
          continue_on_error: true,
        }),
        success: false,
      }),
    });
    expect(mockExecuteAll).toHaveBeenCalledWith(commands, {
      onStart: expect.any(Function),
      onResult: expect.any(Function),
      continueOnExecutionError: true,
    });
  });

  it('propagates required command failures when continueOnError is disabled', async () => {
    const commands = [
      createCommand({ name: 'Install deps', continueOnError: false }),
    ];
    const error = new MockExecutionError(
      'Command failed with exit code 1',
      createFailureResult(commands[0]!),
    );

    mockExecuteAll.mockRejectedValueOnce(error);

    await expect(
      manager.executeEnvironmentRepositoryCommands(
        [{ repository: 'acme/backend', commands }],
        { 'acme/backend': repoPath },
      ),
    ).rejects.toBe(error);

    expect(mockExecuteAll).toHaveBeenCalledWith(commands, {
      onStart: expect.any(Function),
      onResult: expect.any(Function),
      continueOnExecutionError: undefined,
    });
  });

  it('continues through mixed optional and required failures when continueOnError is enabled', async () => {
    const commands = [
      createCommand({ name: 'Install deps', continueOnError: true }),
      createCommand({ name: 'Build app', continueOnError: false }),
      createCommand({ name: 'Start dev server', continueOnError: false }),
    ];
    const onCommandFailure = vi.fn();
    const executedCommands: string[] = [];

    mockExecuteAll.mockImplementationOnce(async (inputCommands, options) => {
      for (const command of inputCommands) {
        executedCommands.push(command.name);
        options.onStart?.(command);

        if (command.name === 'Start dev server') {
          options.onResult?.({
            command,
            success: true,
            duration: 10,
            stdout: 'ok',
            stderr: '',
          });
          continue;
        }

        const failure = createFailureResult(command);

        if (!command.continue_on_error && !options.continueOnExecutionError) {
          throw new MockExecutionError(
            failure.error ?? 'Command failed',
            failure,
          );
        }

        options.onResult?.(failure);
      }

      return [];
    });

    await manager.executeEnvironmentRepositoryCommands(
      [{ repository: 'acme/backend', commands }],
      { 'acme/backend': repoPath },
      undefined,
      { continueOnError: true, onCommandFailure },
    );

    expect(executedCommands).toEqual([
      'Install deps',
      'Build app',
      'Start dev server',
    ]);
    expect(onCommandFailure).toHaveBeenCalledTimes(2);
    expect(onCommandFailure).toHaveBeenNthCalledWith(1, {
      repository: 'acme/backend',
      result: expect.objectContaining({
        command: expect.objectContaining({
          name: 'Install deps',
          continue_on_error: true,
        }),
      }),
    });
    expect(onCommandFailure).toHaveBeenNthCalledWith(2, {
      repository: 'acme/backend',
      result: expect.objectContaining({
        command: expect.objectContaining({
          name: 'Build app',
          continue_on_error: false,
        }),
      }),
    });
  });
});

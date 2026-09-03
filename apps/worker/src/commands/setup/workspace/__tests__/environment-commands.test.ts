import type { NamedPort } from '@roomote/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentWorkspace } from '../../../../workspace';
import type { StartupLogger } from '../../../../logging';
import { resolveLoopback } from '../../../../services/auth-proxy';
import type { EnvironmentSetupStatusWriter } from '../setup-status';
import {
  executeOrganizationEnvironmentRepositoryCommands,
  waitForPreviewPorts,
} from '../environment-commands';

const { executeEnvironmentCommandsMock } = vi.hoisted(() => ({
  executeEnvironmentCommandsMock: vi.fn(),
}));

vi.mock('../../../../services/auth-proxy', () => ({
  resolveLoopback: vi.fn().mockResolvedValue('127.0.0.1'),
}));

vi.mock('../shared', () => ({
  createWorkspaceManager: () => ({
    workspaceManager: {
      executeEnvironmentRepositoryCommands: executeEnvironmentCommandsMock,
    },
  }),
}));

describe('waitForPreviewPorts', () => {
  beforeEach(() => {
    vi.mocked(resolveLoopback).mockResolvedValue('127.0.0.1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('warms configured initial routes and accepts non-server-error responses as ready', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 404,
      }),
    );
    const ports: NamedPort[] = [
      { name: 'web', port: 3000, initial_path: '/auth/dev-login' },
      { name: 'docs', port: 3333 },
    ];

    await expect(waitForPreviewPorts(ports)).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/auth/dev-login',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3333/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('reports a readiness warning when a configured preview never responds', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    const readiness = waitForPreviewPorts([{ name: 'web', port: 3000 }]);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(readiness).resolves.toEqual([
      {
        message:
          'Preview "web" at http://127.0.0.1:3000/ did not become ready within 60 seconds after its detached startup command launched.',
      },
    ]);
  });

  it('retries while a preview returns a server error', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const readiness = waitForPreviewPorts([{ name: 'web', port: 3000 }]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(readiness).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('formats IPv6 loopback URLs correctly', async () => {
    vi.mocked(resolveLoopback).mockResolvedValue('[::1]');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302 }));

    await expect(
      waitForPreviewPorts([{ name: 'web', port: 3000 }]),
    ).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://[::1]:3000/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('keeps network-path initial routes on the loopback authority', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      waitForPreviewPorts([
        {
          name: 'web',
          port: 3000,
          initial_path: '//example.com/path?view=preview#section',
        },
      ]),
    ).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3000//example.com/path?view=preview#section',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});

describe('executeOrganizationEnvironmentRepositoryCommands', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    executeEnvironmentCommandsMock.mockReset();
  });

  it('finalizes timed-out detached previews with a readiness warning', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );
    executeEnvironmentCommandsMock.mockImplementation(
      async (...args: unknown[]) => {
        const options = args[3] as {
          onCommandResult?: (event: {
            repository: string;
            result: {
              command: {
                name: string;
                run: string;
                timeout: number;
                continue_on_error: boolean;
                detached: boolean;
              };
              success: boolean;
              duration: number;
            };
          }) => void;
        };
        options.onCommandResult?.({
          repository: 'owner/repo',
          result: {
            command: {
              name: 'Start app',
              run: 'pnpm dev',
              timeout: 600,
              continue_on_error: false,
              detached: true,
            },
            success: true,
            duration: 2_000,
          },
        });
      },
    );
    const setupStatusWriter = {
      markCommandResult: vi.fn(),
      finalize: vi.fn(),
    } as unknown as EnvironmentSetupStatusWriter;
    const logger = {
      userLog: { log: vi.fn(), warn: vi.fn() },
      debug: { warn: vi.fn() },
    } as unknown as StartupLogger;
    const environment = {
      environmentConfig: {
        repositories: [{ repository: 'owner/repo', commands: [] }],
        ports: [{ name: 'web', port: 3000 }],
      },
    } as unknown as EnvironmentWorkspace;

    const execution = executeOrganizationEnvironmentRepositoryCommands(logger, {
      environment,
      envVars: {},
      preparedWorkspace: {
        workspacePath: '/tmp',
        environment: { repoPaths: { 'owner/repo': '/tmp' } },
      },
      setupStatusWriter,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const expectedWarning =
      'Preview "web" at http://127.0.0.1:3000/ did not become ready within 60 seconds after its detached startup command launched.';

    await expect(execution).resolves.toEqual([{ message: expectedWarning }]);
    expect(setupStatusWriter.finalize).toHaveBeenCalledWith({
      warnings: [expectedWarning],
    });
    expect(logger.userLog.warn).toHaveBeenCalledWith(expectedWarning);
  });
});

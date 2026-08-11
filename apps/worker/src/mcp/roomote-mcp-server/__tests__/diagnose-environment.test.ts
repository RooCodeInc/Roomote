import type { EnvironmentObservation } from '@roomote/types';

import type { DoctorEnvironmentContext } from '../../../doctor/environment-context.js';
import {
  diagnoseEnvironment,
  type DiagnoseEnvironmentDependencies,
} from '../diagnose-environment.js';

const workspacePath = '/workspace';
const now = new Date('2026-08-10T12:00:00.000Z');

function emptyContext(
  overrides: Partial<DoctorEnvironmentContext> = {},
): DoctorEnvironmentContext {
  return {
    ports: [],
    services: [],
    dockerProjects: [],
    toolVersions: [],
    configuredEnvVars: [],
    presentEnvVarNames: [],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<DiagnoseEnvironmentDependencies> = {},
): Partial<DiagnoseEnvironmentDependencies> {
  return {
    now: () => now,
    readSetupStatus: () => ({
      version: 1,
      state: 'completed',
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      commands: [],
      warnings: [],
    }),
    readFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ mtimeMs: now.getTime() })),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })),
    fetch: vi.fn(),
    fetchViaDockerHost: vi.fn(),
    checkTcpPort: vi.fn(async () => true),
    ...overrides,
  };
}

function findCheck(observation: EnvironmentObservation, id: string) {
  const check = observation.checks.find((candidate) => candidate.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe('diagnoseEnvironment', () => {
  it('omits adapters that do not apply to the environment', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const fetch = vi.fn();
    const fetchViaDockerHost = vi.fn();
    const checkTcpPort = vi.fn(async () => true);
    const observation = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies({
        runCommand,
        fetch: fetch as unknown as typeof globalThis.fetch,
        fetchViaDockerHost,
        checkTcpPort,
      }),
    });

    expect(observation.overallStatus).toBe('pass');
    expect(observation.checks.map((check) => check.id)).toEqual([
      'setup.commands',
    ]);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchViaDockerHost).not.toHaveBeenCalled();
    expect(checkTcpPort).not.toHaveBeenCalled();
  });

  it('cannot report healthy when runtime context is unavailable', async () => {
    const observation = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      contextCheck: {
        id: 'context.available',
        category: 'context',
        title: 'Environment context',
        status: 'unknown',
        severity: 'critical',
        summary: 'Environment context is unavailable',
        observedAt: now.toISOString(),
      },
      dependencies: dependencies(),
    });

    expect(observation.overallStatus).toBe('unknown');
    expect(findCheck(observation, 'context.available').status).toBe('unknown');
  });

  it('reports a failed setup command with redacted log evidence', async () => {
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies({
        readSetupStatus: () => ({
          version: 1,
          state: 'completed_with_warnings',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          commands: [
            {
              repository: 'owner/repo',
              name: 'Install dependencies',
              state: 'failed',
              exitCode: 1,
              durationMs: 50,
              logFile: '.roomote/setup-logs/owner/repo/install.log',
            },
          ],
          warnings: [],
        }),
        readFile: vi.fn(async () =>
          [
            'Installing packages',
            'DATABASE_URL=postgresql://user:secret@example.test/db',
            'Error: dependency install failed',
          ].join('\n'),
        ),
      }),
    });

    const summary = findCheck(report, 'setup.commands');
    const command = report.checks.find((check) =>
      check.id.startsWith('setup.commands.owner-repo-install-dependencies'),
    );

    expect(summary.status).toBe('fail');
    expect(command).toMatchObject({ status: 'fail', durationMs: 50 });
    expect(command?.details).toContain('Error: dependency install failed');
    expect(command?.details).toContain('DATABASE_URL=[redacted]');
    expect(JSON.stringify(report)).not.toContain('user:secret');
  });

  it('matches detached commands to the combined PM2 log configured by Roomote', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'pm2') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              name: 'roomote-start-app',
              pm2_env: {
                status: 'online',
                restart_time: 0,
                unstable_restarts: 0,
                pm_log_path: '/workspace/dev.log',
                pm_out_log_path: '/home/roomote/.pm2/logs/start-app-out.log',
                pm_err_log_path: '/home/roomote/.pm2/logs/start-app-error.log',
              },
            },
          ]),
          stderr: '',
        };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies({
        readSetupStatus: () => ({
          version: 1,
          state: 'completed',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          commands: [
            {
              repository: 'owner/repo',
              name: 'Start app',
              state: 'started_detached',
              detached: true,
              logFile: 'dev.log',
            },
          ],
          warnings: [],
        }),
        runCommand,
      }),
    });

    expect(findCheck(report, 'setup.detached_health')).toMatchObject({
      status: 'pass',
      summary: '1 detached process is online',
    });
    expect(
      JSON.stringify(findCheck(report, 'setup.detached_health')),
    ).not.toContain('PM2');
  });

  it('describes detached supervision without exposing the implementation as a workload requirement', async () => {
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies({
        readSetupStatus: () => ({
          version: 1,
          state: 'completed',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          commands: [
            {
              repository: 'owner/repo',
              name: 'Start worker',
              state: 'started_detached',
              detached: true,
              logFile: 'worker.log',
            },
          ],
          warnings: [],
        }),
        runCommand: vi.fn(async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'supervisor unavailable',
        })),
      }),
    });

    const check = findCheck(report, 'setup.detached_health');
    expect(check.status).toBe('fail');
    expect(check.summary).toBe(
      'Detached-process supervisor state could not be read',
    );
    expect(`${check.summary} ${check.remediationHint}`).not.toContain('PM2');
  });

  it('distinguishes working-tree changes that appeared after setup began', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'git') {
        return {
          exitCode: 0,
          stdout: ' M package.json\n?? pnpm-lock.yaml\n',
          stderr: '',
        };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies({
        readSetupStatus: () => ({
          version: 1,
          state: 'completed',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          commands: [],
          warnings: [],
          repositoryBaselines: [
            {
              repository: 'owner/repo',
              path: 'owner/repo',
              changes: [],
            },
          ],
        }),
        runCommand,
      }),
    });

    expect(findCheck(report, 'setup.repository_changes')).toMatchObject({
      status: 'warn',
      summary: '1/1 repository working tree changed after setup began',
    });
    expect(findCheck(report, 'setup.repository_changes').details).toContain(
      'M package.json',
    );
    expect(findCheck(report, 'setup.repository_changes').details).toContain(
      '?? pnpm-lock.yaml',
    );
  });

  it('reports declared and resolved versions when tooling mismatches', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === 'mise' && args.join(' ') === 'current nodejs') {
        return {
          exitCode: 0,
          stdout: 'nodejs 22.17.1',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext({
        toolVersions: [
          {
            tool: 'nodejs',
            declaredVersion: '22.23.1',
            cwd: workspacePath,
            scope: 'workspace',
          },
        ],
      }),
      dependencies: dependencies({ runCommand }),
    });

    const check = findCheck(report, 'tooling.versions');
    expect(check.status).toBe('fail');
    expect(check.details).toContain('declared 22.23.1');
    expect(check.details).toContain('resolved 22.17.1');
  });

  it('uses the configured Compose files, profiles, and working directory', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ State: 'running', Health: 'healthy' }),
      stderr: '',
    }));
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext({
        dockerProjects: [
          {
            name: 'app',
            required: true,
            cwd: '/workspace/owner/repo/deploy',
            composeFiles: [
              '/workspace/owner/repo/deploy/compose.roomote.yml',
              '/workspace/.roomote/docker-projects/roomote-app.ports.yaml',
            ],
            profiles: ['web'],
          },
        ],
      }),
      dependencies: dependencies({ runCommand }),
    });

    expect(findCheck(report, 'docker.projects').status).toBe('pass');
    expect(runCommand).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--project-name',
        'roomote-app',
        '--file',
        '/workspace/owner/repo/deploy/compose.roomote.yml',
        '--file',
        '/workspace/.roomote/docker-projects/roomote-app.ports.yaml',
        '--profile',
        'web',
        'ps',
        '--all',
        '--format',
        'json',
      ],
      { cwd: '/workspace/owner/repo/deploy' },
    );
  });

  it('preserves query strings and fragments from the configured initial path', async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
    })) as unknown as typeof globalThis.fetch;
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext({
        ports: [
          {
            name: 'WEB',
            port: 3000,
            initialPath: '/?path=/story/example#anchor',
            previewUrl: 'https://preview.example.test',
          },
        ],
      }),
      dependencies: dependencies({ fetch }),
    });

    expect(findCheck(report, 'port.WEB.loopback').status).toBe('pass');
    expect(findCheck(report, 'port.WEB.preview').status).toBe('pass');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/?path=/story/example#anchor',
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://preview.example.test/?path=/story/example#anchor',
      expect.any(Object),
    );
  });

  it('reaches local Docker previews with the default bypass header', async () => {
    const originalBypassValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;
    const originalBypassHeaderName =
      process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'test-bypass-value';
    delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;

    try {
      const fetch = vi.fn(async (url: string | URL | Request) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === 'task-web.roopreview.localhost') {
          const error = new TypeError('fetch failed', {
            cause: { code: 'ECONNREFUSED' },
          });
          throw error;
        }
        return { status: 200 };
      }) as unknown as typeof globalThis.fetch;
      const fetchViaDockerHost = vi.fn(async () => ({ status: 200 }));
      const report = await diagnoseEnvironment({
        workspacePath,
        context: emptyContext({
          ports: [
            {
              name: 'WEB',
              port: 3000,
              initialPath: '/',
              previewUrl: 'http://task-web.roopreview.localhost:18181/',
            },
          ],
        }),
        dependencies: dependencies({ fetch, fetchViaDockerHost }),
      });

      expect(findCheck(report, 'port.WEB.preview')).toMatchObject({
        status: 'pass',
        summary:
          'http://task-web.roopreview.localhost:18181/ returned HTTP 200 (2xx)',
      });
      expect(fetchViaDockerHost).toHaveBeenCalledWith(
        'http://task-web.roopreview.localhost:18181/',
        expect.objectContaining({
          headers: {
            'x-bypass-roomote-auth': 'test-bypass-value',
          },
        }),
      );
    } finally {
      if (originalBypassValue === undefined) {
        delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
      } else {
        process.env.ROOMOTE_AUTH_BYPASS_VALUE = originalBypassValue;
      }
      if (originalBypassHeaderName === undefined) {
        delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
      } else {
        process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = originalBypassHeaderName;
      }
    }
  });
});

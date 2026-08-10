import type { DoctorReport } from '@roomote/types';

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
    checkTcpPort: vi.fn(async () => true),
    ...overrides,
  };
}

function findCheck(report: DoctorReport, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe('diagnoseEnvironment', () => {
  it('returns an all-pass report for a healthy environment without optional resources', async () => {
    const report = await diagnoseEnvironment({
      workspacePath,
      context: emptyContext(),
      dependencies: dependencies(),
    });

    expect(report.overallStatus).toBe('pass');
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
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
});

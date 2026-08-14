import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskPayloadKind } from '@roomote/types';

import type { StartupLogger } from '../../../logging';
import { initializeDockerProjects } from '../workspace/docker-projects';
import {
  appendDockerProjectLog,
  startDockerProjectLogFollower,
} from '../workspace/docker-project-logs';

vi.mock('../workspace/docker-project-logs', () => ({
  appendDockerProjectLog: vi.fn().mockResolvedValue(undefined),
  startDockerProjectLogFollower: vi.fn().mockResolvedValue(undefined),
}));

const logger = {
  userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as StartupLogger;

describe('initializeDockerProjects', () => {
  let workspacePath: string;
  let repositoryPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'roomote-compose-'),
    );
    repositoryPath = path.join(workspacePath, 'app');
    await fs.mkdir(repositoryPath, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('initializes Docker without starting a placeholder project when requested', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            nested_docker: true,
          },
        },
        envVars: { PATH: '/usr/bin' },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledWith(
      'docker',
      ['info'],
      expect.objectContaining({ cwd: workspacePath }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', 'version'],
      expect.objectContaining({ cwd: workspacePath }),
    );
    expect(logger.userLog.log).toHaveBeenCalledWith('Docker runtime is ready');
    expect(startDockerProjectLogFollower).not.toHaveBeenCalled();
  });

  it('validates and starts an existing Compose project after repository cloning', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            ports: [{ name: 'WEB', port: 3000 }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
                ports: [
                  {
                    named_port: 'WEB',
                    service: 'web',
                    container_port: 80,
                  },
                ],
              },
            ],
          },
        },
        envVars: { PATH: '/usr/bin' },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    expect(runCommand).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['config', '--quiet']),
      expect.objectContaining({ cwd: repositoryPath }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['up', '--detach', '--build', '--wait']),
      expect.objectContaining({ cwd: repositoryPath }),
    );

    const generatedFiles = await fs.readdir(
      path.join(workspacePath, '.roomote', 'docker-projects'),
    );
    expect(generatedFiles).toContain('roomote-dev.ports.yaml');

    expect(appendDockerProjectLog).toHaveBeenCalledWith(
      'dev',
      expect.stringContaining('Preparing Docker project dev'),
    );
    expect(startDockerProjectLogFollower).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'dev',
        cwd: repositoryPath,
        composeArgs: expect.arrayContaining([
          'compose',
          '--project-name',
          'roomote-dev',
        ]),
      }),
    );
  });

  it('generates a one-service Compose project for a Dockerfile', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'Dockerfile'),
      'FROM nginx:alpine\n',
    );
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'dockerfile',
                name: 'web',
                repository: 'acme/app',
              },
            ],
          },
        },
        envVars: {},
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    const generated = await fs.readFile(
      path.join(
        workspacePath,
        '.roomote',
        'docker-projects',
        'roomote-web.dockerfile.yaml',
      ),
      'utf8',
    );
    expect(generated).toContain('services:');
    expect(generated).toContain('app:');
    expect(generated).toContain('Dockerfile');
  });

  it('starts a fallback Docker daemon without leaving a rejecting detached subprocess', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('Docker daemon is unavailable'))
      .mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
              },
            ],
          },
        },
        envVars: { PATH: '/usr/bin' },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    expect(runCommand).toHaveBeenCalledWith(
      'sudo',
      ['sh', '-c', expect.stringContaining('nohup dockerd')],
      expect.objectContaining({
        env: expect.objectContaining({
          ROOMOTE_DOCKER_DAEMON_HOST: 'unix:///var/run/docker.sock',
        }),
      }),
    );
  });

  it('starts the fallback daemon on the configured Docker host', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('Docker daemon is unavailable'))
      .mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
              },
            ],
          },
        },
        envVars: {
          DOCKER_HOST: 'tcp://127.0.0.1:2375',
          PATH: '/usr/bin',
        },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    expect(runCommand).toHaveBeenCalledWith(
      'sudo',
      ['sh', '-c', expect.stringContaining('ROOMOTE_DOCKER_DAEMON_HOST')],
      expect.objectContaining({
        env: expect.objectContaining({
          ROOMOTE_DOCKER_DAEMON_HOST: 'tcp://127.0.0.1:2375',
        }),
      }),
    );
  });

  it('starts Blaxel projects without the unsupported healthcheck wait', async () => {
    // The provider is injected into the worker's process env at sandbox
    // creation; it never arrives through the job's envVars.
    vi.stubEnv('COMPUTE_PROVIDER', 'blaxel');
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
              },
            ],
          },
        },
        envVars: { PATH: '/usr/bin' },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    const startCall = runCommand.mock.calls.find(
      ([command, args]) => command === 'docker' && args.includes('up'),
    );
    expect(startCall).toBeDefined();
    expect(startCall?.[1]).not.toContain('--wait');
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('does not support Docker healthchecks'),
    );
  });

  it('continues when an optional project fails', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services: {}\n',
    );
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('invalid compose'));

    await expect(
      initializeDockerProjects(
        logger,
        {
          workspace: {
            type: 'environment',
            environmentId: 'env-1',
            environmentConfig: {
              name: 'Test',
              repositories: [{ repository: 'acme/app' }],
              docker_projects: [
                {
                  type: 'compose',
                  name: 'optional',
                  repository: 'acme/app',
                  files: ['compose.yaml'],
                  required: false,
                },
              ],
            },
          },
          envVars: {},
          taskRunType: TaskPayloadKind.StandardTask,
        },
        {
          workspacePath,
          repoPaths: { 'acme/app': repositoryPath },
        },
        runCommand,
      ),
    ).resolves.toBeUndefined();

    expect(logger.userLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Continuing because it is optional'),
    );
  });

  it('redacts project values without redacting the base command environment', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('up')) throw new Error('compose failed');
      if (args.includes('ps')) {
        return {
          stdout: 'PATH=/opt/roomote/bin APP_SECRET=project-secret-value',
        };
      }
      return { stdout: '' };
    });

    const result = initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
                env: { APP_SECRET: '${PROJECT_SECRET}' },
              },
            ],
          },
        },
        envVars: {
          PATH: '/opt/roomote/bin',
          PROJECT_SECRET: 'project-secret-value',
        },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    await expect(result).rejects.toThrow('PATH=/opt/roomote/bin');
    await expect(result).rejects.toThrow('APP_SECRET=[redacted]');
    await expect(result).rejects.not.toThrow('project-secret-value');
  });

  it('redacts project values from failure output written to the project log', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('up')) {
        // Compose stderr echoing a substituted project env value ends up on
        // the thrown error message.
        throw new Error('compose failed: APP_SECRET=project-secret-value');
      }
      return { stdout: '' };
    });

    const result = initializeDockerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            docker_projects: [
              {
                type: 'compose',
                name: 'dev',
                repository: 'acme/app',
                files: ['compose.yaml'],
                env: { APP_SECRET: '${PROJECT_SECRET}' },
              },
            ],
          },
        },
        envVars: { PROJECT_SECRET: 'project-secret-value' },
        taskRunType: TaskPayloadKind.StandardTask,
      },
      {
        workspacePath,
        repoPaths: { 'acme/app': repositoryPath },
      },
      runCommand,
    );

    await expect(result).rejects.toThrow('APP_SECRET=[redacted]');
    await expect(result).rejects.not.toThrow('project-secret-value');

    const appendedText = vi
      .mocked(appendDockerProjectLog)
      .mock.calls.map((call) => call[1])
      .join('\n');
    expect(appendedText).toContain('APP_SECRET=[redacted]');
    expect(appendedText).not.toContain('project-secret-value');
  });

  it('keeps optional-project failure logging redacted', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('up')) {
        throw new Error('compose failed: APP_SECRET=project-secret-value');
      }
      return { stdout: '' };
    });

    await expect(
      initializeDockerProjects(
        logger,
        {
          workspace: {
            type: 'environment',
            environmentId: 'env-1',
            environmentConfig: {
              name: 'Test',
              repositories: [{ repository: 'acme/app' }],
              docker_projects: [
                {
                  type: 'compose',
                  name: 'optional',
                  repository: 'acme/app',
                  files: ['compose.yaml'],
                  env: { APP_SECRET: '${PROJECT_SECRET}' },
                  required: false,
                },
              ],
            },
          },
          envVars: { PROJECT_SECRET: 'project-secret-value' },
          taskRunType: TaskPayloadKind.StandardTask,
        },
        {
          workspacePath,
          repoPaths: { 'acme/app': repositoryPath },
        },
        runCommand,
      ),
    ).resolves.toBeUndefined();

    const loggedText = [
      ...vi.mocked(logger.userLog.warn).mock.calls,
      ...vi.mocked(logger.debug.error).mock.calls,
      ...vi.mocked(appendDockerProjectLog).mock.calls.map((call) => [call[1]]),
    ]
      .flat()
      .map(String)
      .join('\n');
    expect(loggedText).toContain('APP_SECRET=[redacted]');
    expect(loggedText).not.toContain('project-secret-value');
  });
});

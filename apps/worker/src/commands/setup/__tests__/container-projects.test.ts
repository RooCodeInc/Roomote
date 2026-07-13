import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskPayloadKind } from '@roomote/types';

import type { StartupLogger } from '../../../logging';
import { initializeContainerProjects } from '../workspace/container-projects';

const logger = {
  userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as StartupLogger;

describe('initializeContainerProjects', () => {
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
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('validates and starts an existing Compose project after repository cloning', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:alpine\n',
    );
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeContainerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            ports: [{ name: 'WEB', port: 3000 }],
            container_projects: [
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
      path.join(workspacePath, '.roomote', 'container-projects'),
    );
    expect(generatedFiles).toContain('roomote-dev.ports.yaml');
  });

  it('generates a one-service Compose project for a Dockerfile', async () => {
    await fs.writeFile(
      path.join(repositoryPath, 'Dockerfile'),
      'FROM nginx:alpine\n',
    );
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' });

    await initializeContainerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            container_projects: [
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
        'container-projects',
        'roomote-web.dockerfile.yaml',
      ),
      'utf8',
    );
    expect(generated).toContain('services:');
    expect(generated).toContain('app:');
    expect(generated).toContain('Dockerfile');
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
      initializeContainerProjects(
        logger,
        {
          workspace: {
            type: 'environment',
            environmentId: 'env-1',
            environmentConfig: {
              name: 'Test',
              repositories: [{ repository: 'acme/app' }],
              container_projects: [
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

    const result = initializeContainerProjects(
      logger,
      {
        workspace: {
          type: 'environment',
          environmentId: 'env-1',
          environmentConfig: {
            name: 'Test',
            repositories: [{ repository: 'acme/app' }],
            container_projects: [
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
});

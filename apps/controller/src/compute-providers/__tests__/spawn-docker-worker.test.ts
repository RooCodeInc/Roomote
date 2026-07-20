import { describe, expect, it } from 'vitest';

import {
  DockerBootError,
  processListIncludesDockerWorkerRun,
  type DockerCommand,
} from '../docker-sandbox-security';
import {
  buildDockerSandboxServerUrl,
  DOCKER_SPAWN_TIMEOUT_MS,
  getDockerWorkerCommand,
  preflightDockerSpawn,
  resolveDockerSpawnCleanupMode,
  resolveDockerWorkerOwnershipTargetFromLookup,
  resumeDockerTaskDaemon,
  shouldPreserveFailedDockerWorkerContainer,
  shouldRetryDockerWorkerWithoutDiskLimit,
  shouldAutoRemoveDockerWorkerContainer,
  toContainerReachableUrl,
} from '../spawn-docker-worker';
import { TaskPayloadKind, TaskRunErrorCode } from '@roomote/types';

describe('processListIncludesDockerWorkerRun', () => {
  it('matches the shell launcher command while the Docker worker is starting', () => {
    expect(
      processListIncludesDockerWorkerRun(
        [
          'COMMAND',
          'bash -lc worker run 12 > /proc/1/fd/1 2> /proc/1/fd/2',
        ].join('\n'),
        12,
      ),
    ).toBe(true);
  });

  it('matches the resolved Node worker process after the launcher execs', () => {
    expect(
      processListIncludesDockerWorkerRun(
        [
          'COMMAND',
          '/opt/mise/installs/node/22.17.1/bin/node --no-opt -r /proc/.reset /sandbox/worker/dist/worker.js run 12',
        ].join('\n'),
        12,
      ),
    ).toBe(true);
  });

  it('does not match other task runs', () => {
    expect(
      processListIncludesDockerWorkerRun(
        '/sandbox/worker/dist/worker.js run 13',
        12,
      ),
    ).toBe(false);
  });

  it('matches a retained container running the resume command', () => {
    expect(
      processListIncludesDockerWorkerRun(
        '/sandbox/worker/dist/worker.js resume 14',
        14,
      ),
    ).toBe(true);
  });
});

describe('getDockerWorkerCommand', () => {
  it('uses resume only for standby resume task runs', () => {
    expect(getDockerWorkerCommand(TaskPayloadKind.SnapshotResume)).toBe(
      'resume',
    );
    expect(getDockerWorkerCommand(TaskPayloadKind.StandardTask)).toBe('run');
  });
});

describe('DOCKER_SPAWN_TIMEOUT_MS', () => {
  it('caps provisioning well below the full sandbox lifetime', () => {
    expect(DOCKER_SPAWN_TIMEOUT_MS).toBe(15 * 60 * 1_000);
  });
});

describe('shouldPreserveFailedDockerWorkerContainer', () => {
  it('preserves ordinary development spawn failures for local debugging', () => {
    expect(
      shouldPreserveFailedDockerWorkerContainer({
        aborted: false,
        appEnv: 'development',
        hasContainerId: true,
      }),
    ).toBe(true);
  });

  it('cleans up canceled or timed-out partial provisions even in development', () => {
    expect(
      shouldPreserveFailedDockerWorkerContainer({
        aborted: true,
        appEnv: 'development',
        hasContainerId: true,
      }),
    ).toBe(false);
  });

  it('always cleans up outside development', () => {
    expect(
      shouldPreserveFailedDockerWorkerContainer({
        aborted: false,
        appEnv: 'production',
        hasContainerId: true,
      }),
    ).toBe(false);
  });
});

describe('resolveDockerSpawnCleanupMode', () => {
  it('never deletes a retained snapshot on standby resume abort', () => {
    expect(
      resolveDockerSpawnCleanupMode({
        isStandbyResume: true,
        aborted: true,
        appEnv: 'production',
        hasContainerId: false,
      }),
    ).toBe('stop-retained');
  });

  it('removes fresh spawn resources when canceled', () => {
    expect(
      resolveDockerSpawnCleanupMode({
        isStandbyResume: false,
        aborted: true,
        appEnv: 'development',
        hasContainerId: true,
      }),
    ).toBe('remove');
  });
});

describe('resumeDockerTaskDaemon', () => {
  it('tolerates a missing retained daemon container', async () => {
    const runDocker = vi.fn().mockResolvedValue('');

    await resumeDockerTaskDaemon('roomote-worker-42-docker', runDocker);

    expect(runDocker).toHaveBeenCalledWith(
      ['start', 'roomote-worker-42-docker'],
      { allowFailure: true },
    );
  });
});

describe('shouldRetryDockerWorkerWithoutDiskLimit', () => {
  const unsupportedStorageError = {
    stderr: '--storage-opt is not supported by the overlay2 storage driver',
  };

  it('fails closed unless unbounded disk use is explicitly allowed', () => {
    expect(() =>
      shouldRetryDockerWorkerWithoutDiskLimit({
        diskLimit: '20g',
        allowUnboundedDisk: false,
        error: unsupportedStorageError,
      }),
    ).toThrow('Refusing to start an unbounded task');
  });

  it('retries only for an opted-in unsupported storage driver', () => {
    expect(
      shouldRetryDockerWorkerWithoutDiskLimit({
        diskLimit: '20g',
        allowUnboundedDisk: true,
        error: unsupportedStorageError,
      }),
    ).toBe(true);
    expect(
      shouldRetryDockerWorkerWithoutDiskLimit({
        diskLimit: '20g',
        allowUnboundedDisk: true,
        error: new Error('image not found'),
      }),
    ).toBe(false);
  });
});

describe('buildDockerSandboxServerUrl', () => {
  it('builds a preview-proxy sandbox server URL for networked Docker workers', () => {
    expect(
      buildDockerSandboxServerUrl({
        network: 'roomote_default',
        taskId: 'task123456789',
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
      }),
    ).toBe('https://task123456789-sandbox-server.preview.roomote.example.com');
  });

  it('routes local Docker sandbox transport through the public app origin', () => {
    expect(
      buildDockerSandboxServerUrl({
        taskId: 'task123456789',
        publicAppUrl: 'https://roomote-example.ngrok.app/',
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
      }),
    ).toBe('https://roomote-example.ngrok.app/_roomote-sandbox/task123456789');
  });

  it('keeps the direct published URL fallback without a public app origin', () => {
    expect(
      buildDockerSandboxServerUrl({
        taskId: 'task123456789',
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
      }),
    ).toBeUndefined();
  });
});

describe('toContainerReachableUrl', () => {
  it('rewrites localhost URLs for Docker without adding a trailing slash', () => {
    expect(toContainerReachableUrl('http://localhost:13001')).toBe(
      'http://host.docker.internal:13001',
    );
    expect(toContainerReachableUrl('http://127.0.0.1:13000/')).toBe(
      'http://host.docker.internal:13000',
    );
  });

  it('trims trailing slashes from non-localhost URLs', () => {
    expect(toContainerReachableUrl('https://roomote.example.com/')).toBe(
      'https://roomote.example.com',
    );
  });
});

describe('shouldAutoRemoveDockerWorkerContainer', () => {
  it('preserves containers in every environment for bounded standby retention', () => {
    expect(shouldAutoRemoveDockerWorkerContainer('production')).toBe(false);
    expect(shouldAutoRemoveDockerWorkerContainer('preview')).toBe(false);
    expect(shouldAutoRemoveDockerWorkerContainer('development')).toBe(false);
  });
});

describe('resolveDockerWorkerOwnershipTargetFromLookup', () => {
  it('uses root ownership when the image user is unset', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({ imageUser: '' }),
    ).toBe('root:root');
  });

  it('preserves explicit user and group values from the image', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: '1000:1001',
      }),
    ).toBe('1000:1001');
  });

  it('uses the same numeric uid and gid for numeric image users', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({ imageUser: '1000' }),
    ).toBe('1000:1000');
  });

  it('resolves named image users to their primary group name', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: 'vercel-sandbox',
        passwdEntry:
          'vercel-sandbox:x:1001:1001::/home/vercel-sandbox:/bin/bash',
        groupEntry: 'vercel-sandbox:x:1001:',
      }),
    ).toBe('vercel-sandbox:vercel-sandbox');
  });

  it('falls back to the primary gid when the group lookup is unavailable', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: 'ubuntu',
        passwdEntry: 'ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash',
      }),
    ).toBe('ubuntu:1000');
  });
});

describe('preflightDockerSpawn', () => {
  const IMAGE = 'roomote-worker:local';

  const makeRunDocker = (
    behavior: (args: string[]) => Promise<string>,
  ): DockerCommand => {
    return (args, options = {}) =>
      behavior(args).catch((error) => {
        if (options.allowFailure) {
          return '';
        }
        throw error;
      });
  };

  it('passes when the daemon responds and the image exists locally', async () => {
    const calls: string[][] = [];
    const runDocker = makeRunDocker(async (args) => {
      calls.push(args);
      if (args[0] === 'version') {
        return '28.0.1\n';
      }
      if (args[0] === 'image') {
        return 'sha256:abc\n';
      }
      throw new Error(`unexpected docker ${args[0]}`);
    });

    await expect(
      preflightDockerSpawn(runDocker, IMAGE),
    ).resolves.toBeUndefined();
    expect(calls.some((args) => args[0] === 'pull')).toBe(false);
  });

  it('throws DockerDaemonUnreachable when the daemon does not respond', async () => {
    const runDocker = makeRunDocker(async (args) => {
      if (args[0] === 'version') {
        throw new Error(
          'Failed to run docker version.\n\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        );
      }
      return '';
    });

    const failure = await preflightDockerSpawn(runDocker, IMAGE).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DockerBootError);
    expect((failure as DockerBootError).errorCode).toBe(
      TaskRunErrorCode.DockerDaemonUnreachable,
    );
    expect((failure as Error).message).toContain(
      'Cannot connect to the Docker daemon',
    );
  });

  it('pulls a locally missing image before giving up', async () => {
    const calls: string[][] = [];
    const runDocker = makeRunDocker(async (args) => {
      calls.push(args);
      if (args[0] === 'version') {
        return '28.0.1\n';
      }
      if (args[0] === 'image') {
        throw new Error('No such image');
      }
      if (args[0] === 'pull') {
        return 'Downloaded newer image\n';
      }
      throw new Error(`unexpected docker ${args[0]}`);
    });

    await expect(
      preflightDockerSpawn(runDocker, IMAGE),
    ).resolves.toBeUndefined();
    expect(calls.some((args) => args[0] === 'pull' && args[1] === IMAGE)).toBe(
      true,
    );
  });

  it('throws DockerImageMissing when the image cannot be pulled', async () => {
    const runDocker = makeRunDocker(async (args) => {
      if (args[0] === 'version') {
        return '28.0.1\n';
      }
      if (args[0] === 'image') {
        throw new Error('No such image');
      }
      throw new Error(
        "Failed to run docker pull.\n\npull access denied for roomote-worker, repository does not exist or may require 'docker login'",
      );
    });

    const failure = await preflightDockerSpawn(runDocker, IMAGE).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DockerBootError);
    expect((failure as DockerBootError).errorCode).toBe(
      TaskRunErrorCode.DockerImageMissing,
    );
    expect((failure as Error).message).toContain(IMAGE);
    expect((failure as Error).message).toContain('pull access denied');
  });

  it('rethrows aborts without reclassifying them as boot failures', async () => {
    const abortError = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const runDocker = makeRunDocker(async () => {
      throw abortError;
    });

    await expect(preflightDockerSpawn(runDocker, IMAGE)).rejects.toBe(
      abortError,
    );
  });
});

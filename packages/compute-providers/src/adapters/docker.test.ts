import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => {
  function execFile(
    file: string,
    args: readonly string[] | null | undefined,
    options:
      | {
          maxBuffer?: number;
          signal?: AbortSignal;
        }
      | undefined,
  ) {
    return execFileMock(file, args, options);
  }

  execFile[promisify.custom] = (
    file: string,
    args: readonly string[] | null | undefined,
    options?: {
      maxBuffer?: number;
      signal?: AbortSignal;
    },
  ) =>
    Promise.resolve(execFileMock(file, args, options)).then((result) => {
      if (typeof result === 'string') {
        return { stdout: result, stderr: '' };
      }
      return {
        stdout: (result as { stdout?: string } | undefined)?.stdout ?? '',
        stderr: (result as { stderr?: string } | undefined)?.stderr ?? '',
      };
    });

  return { execFile };
});

import { DockerClient, isDockerMissingObjectError } from './docker';

describe('isDockerMissingObjectError', () => {
  it('detects missing container messages from docker inspect', () => {
    expect(
      isDockerMissingObjectError(
        new Error(
          'Error response from daemon: No such object: roomote-worker-24',
        ),
      ),
    ).toBe(true);
  });

  it('does not treat daemon connection failures as missing objects', () => {
    expect(
      isDockerMissingObjectError(
        new Error(
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        ),
      ),
    ).toBe(false);
  });
});

describe('DockerClient.getInstanceStatus', () => {
  const client = new DockerClient();

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    execFileMock.mockReset();
  });

  it('maps a running container status', async () => {
    execFileMock.mockResolvedValue({ stdout: 'running\n' });

    await expect(
      client.getInstanceStatus({ instanceId: 'roomote-worker-1' }),
    ).resolves.toEqual({ status: 'running' });

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      ['inspect', '--format', '{{.State.Status}}', 'roomote-worker-1'],
      expect.anything(),
    );
  });

  it('maps missing containers to stopped', async () => {
    const error = Object.assign(new Error('docker inspect failed'), {
      stderr: 'Error: No such object: roomote-worker-1',
    });
    execFileMock.mockRejectedValue(error);

    await expect(
      client.getInstanceStatus({ instanceId: 'roomote-worker-1' }),
    ).resolves.toEqual({ status: 'stopped' });
  });

  it('rethrows daemon connectivity failures instead of returning unknown', async () => {
    execFileMock.mockRejectedValue(
      new Error(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
    );

    await expect(
      client.getInstanceStatus({ instanceId: 'roomote-worker-1' }),
    ).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });
});

import { describe, expect, it } from 'vitest';

import { validateDockerEnvironment } from '../docker-environment-validation';

const IMAGE = 'roomote-worker:local';

describe('validateDockerEnvironment', () => {
  it('passes all checks in a healthy environment', async () => {
    const result = await validateDockerEnvironment({
      image: IMAGE,
      releaseArchivePath: '/releases/worker-current.tar.gz',
      runDocker: async (args) => {
        if (args[0] === 'version') return '28.0.1';
        if (args[0] === 'image') return 'sha256:abc';
        throw new Error(`unexpected docker ${args[0]}`);
      },
      fileExists: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('fails the daemon check and skips the image check when the daemon is down', async () => {
    const result = await validateDockerEnvironment({
      image: IMAGE,
      releaseArchivePath: '/releases/worker-current.tar.gz',
      runDocker: async () => {
        throw new Error(
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        );
      },
      fileExists: () => true,
    });

    expect(result.ok).toBe(false);
    const [daemon, image] = result.checks;
    expect(daemon?.status).toBe('fail');
    expect(daemon?.message).toContain('Cannot connect to the Docker daemon');
    expect(image?.status).toBe('skipped');
  });

  it('pulls a missing image and reports the pull as a pass', async () => {
    const calls: string[] = [];
    const result = await validateDockerEnvironment({
      image: IMAGE,
      releaseArchivePath: '/releases/worker-current.tar.gz',
      runDocker: async (args) => {
        calls.push(args[0] ?? '');
        if (args[0] === 'version') return '28.0.1';
        if (args[0] === 'image') throw new Error('No such image');
        if (args[0] === 'pull') return 'Downloaded';
        throw new Error(`unexpected docker ${args[0]}`);
      },
      fileExists: () => true,
    });

    expect(result.ok).toBe(true);
    expect(calls).toContain('pull');
    expect(result.checks[1]?.message).toContain('pulled successfully');
  });

  it('fails the image check with stderr detail when the pull fails', async () => {
    const pullError = Object.assign(new Error('Command failed'), {
      stderr:
        'pull access denied for roomote-worker, repository does not exist',
    });
    const result = await validateDockerEnvironment({
      image: IMAGE,
      releaseArchivePath: '/releases/worker-current.tar.gz',
      runDocker: async (args) => {
        if (args[0] === 'version') return '28.0.1';
        throw args[0] === 'pull' ? pullError : new Error('No such image');
      },
      fileExists: () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks[1]?.status).toBe('fail');
    expect(result.checks[1]?.message).toContain('pull access denied');
  });

  it('marks the archive check skipped when no path is configured and failed when missing', async () => {
    const healthyDocker = async (args: string[]) =>
      args[0] === 'version' ? '28.0.1' : 'sha256:abc';

    const skipped = await validateDockerEnvironment({
      image: IMAGE,
      runDocker: healthyDocker,
      fileExists: () => true,
    });
    expect(skipped.ok).toBe(true);
    expect(skipped.checks[2]?.status).toBe('skipped');

    const missing = await validateDockerEnvironment({
      image: IMAGE,
      releaseArchivePath: '/releases/worker-current.tar.gz',
      runDocker: healthyDocker,
      fileExists: () => false,
    });
    expect(missing.ok).toBe(false);
    expect(missing.checks[2]?.status).toBe('fail');
  });
});

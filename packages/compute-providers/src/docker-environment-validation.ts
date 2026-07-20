import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DockerEnvironmentCheckId =
  | 'daemon'
  | 'worker_image'
  | 'release_archive';

export type DockerEnvironmentCheckStatus = 'pass' | 'fail' | 'skipped';

export interface DockerEnvironmentCheck {
  id: DockerEnvironmentCheckId;
  status: DockerEnvironmentCheckStatus;
  /** Human-readable outcome shown in the settings UI. */
  message: string;
}

export interface DockerEnvironmentValidationResult {
  ok: boolean;
  checks: DockerEnvironmentCheck[];
}

type DockerRunner = (args: string[]) => Promise<string>;

async function runDockerCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout.trim();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const failure = error as Error & { stderr?: string | Buffer };
    const stderr =
      typeof failure.stderr === 'string'
        ? failure.stderr.trim()
        : Buffer.isBuffer(failure.stderr)
          ? failure.stderr.toString('utf8').trim()
          : '';

    return stderr || error.message;
  }

  return String(error);
}

/**
 * Run the same environment checks the controller preflights before a Docker
 * spawn — daemon reachable, worker image present (or pullable), release
 * archive on disk — but report per-check results instead of failing fast, so
 * the settings UI can show operators everything that needs fixing at once.
 *
 * Must run in a process with Docker socket access (bullmq/controller); the
 * web app does not have the socket in production Compose.
 */
export async function validateDockerEnvironment(params: {
  image: string;
  /** Absent when the running process has no release path configured. */
  releaseArchivePath?: string;
  runDocker?: DockerRunner;
  fileExists?: (path: string) => boolean;
}): Promise<DockerEnvironmentValidationResult> {
  const runDocker = params.runDocker ?? runDockerCli;
  const fileExists = params.fileExists ?? existsSync;
  const checks: DockerEnvironmentCheck[] = [];

  let daemonReachable = false;

  try {
    const version = await runDocker([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    daemonReachable = true;
    checks.push({
      id: 'daemon',
      status: 'pass',
      message: `Docker daemon is reachable (server ${version.trim() || 'unknown'}).`,
    });
  } catch (error) {
    checks.push({
      id: 'daemon',
      status: 'fail',
      message: `Cannot reach the Docker daemon: ${errorMessage(error)}`,
    });
  }

  if (!daemonReachable) {
    checks.push({
      id: 'worker_image',
      status: 'skipped',
      message: 'Skipped because the Docker daemon is unreachable.',
    });
  } else {
    try {
      await runDocker([
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        params.image,
      ]);
      checks.push({
        id: 'worker_image',
        status: 'pass',
        message: `Worker image ${params.image} is available locally.`,
      });
    } catch {
      try {
        await runDocker(['pull', params.image]);
        checks.push({
          id: 'worker_image',
          status: 'pass',
          message: `Worker image ${params.image} was pulled successfully.`,
        });
      } catch (error) {
        checks.push({
          id: 'worker_image',
          status: 'fail',
          message: `Worker image ${params.image} is not available locally and could not be pulled: ${errorMessage(error)}`,
        });
      }
    }
  }

  if (!params.releaseArchivePath) {
    checks.push({
      id: 'release_archive',
      status: 'skipped',
      message:
        'No worker release archive path is configured for this process (DOCKER_WORKER_RELEASE_PATH).',
    });
  } else if (fileExists(params.releaseArchivePath)) {
    checks.push({
      id: 'release_archive',
      status: 'pass',
      message: `Worker release archive exists at ${params.releaseArchivePath}.`,
    });
  } else {
    checks.push({
      id: 'release_archive',
      status: 'fail',
      message: `Worker release archive does not exist: ${params.releaseArchivePath}`,
    });
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

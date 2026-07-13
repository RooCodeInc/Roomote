import path from 'path';

import { execa } from 'execa';
import ora from 'ora';
import Docker from 'dockerode';

export const WORKER_IMAGE_SCHEMA_LABEL =
  'dev.roomote.worker-image.schema-version';
export const WORKER_IMAGE_SCHEMA_VERSION = '1';

export class DockerService {
  private static readonly CURRENT_COMPOSE_PROJECT = 'roomote';
  private static readonly REQUIRED_CONTAINERS = [
    'roomote-postgres',
    'roomote-redis',
    'roomote-minio',
    'roomote-caddy-dev',
  ];
  private static readonly INFRA_SERVICES = [
    'postgres',
    'redis',
    'minio',
    'minio-init',
    'caddy-dev',
  ];
  private static readonly EXPECTED_PUBLIC_INFRA_PORTS: Record<string, number> =
    {
      postgres: 15432,
      redis: 16379,
      minio: 19000,
      'caddy-dev': 18080,
    };
  private static readonly SELF_HOST_APP_SERVICES = [
    'api',
    'bullmq',
    'controller',
    'db-migrate',
    'preview-proxy',
    'web',
  ];
  private static readonly LEGACY_CONTAINERS = [
    'roomote-postgres',
    'roomote-redis',
    'roomote-minio',
  ];
  private static readonly DEFAULT_WORKER_IMAGE = 'roomote-worker:local';
  // Host arch, so Apple Silicon dev machines build/run the worker natively.
  private static readonly DEFAULT_WORKER_PLATFORM =
    process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  private static readonly INFRA_UP_ENV_VARS_TO_OMIT = [
    'DATABASE_URL',
    'DATABASE_URL_TEST',
    'REDIS_URL',
    'PGDATABASE',
    'PGHOST',
    'PGPASSWORD',
    'PGPORT',
    'PGUSER',
  ];

  static async ensureWorkerImage(verbose: boolean): Promise<void> {
    const image = process.env.DOCKER_WORKER_IMAGE ?? this.DEFAULT_WORKER_IMAGE;
    const platform =
      process.env.DOCKER_WORKER_PLATFORM ?? this.DEFAULT_WORKER_PLATFORM;
    const rootDir = path.resolve(process.cwd(), '../..');

    if (
      (await this.hasCurrentWorkerImageSchema(image)) &&
      (await this.hasRequiredWorkerImageTools(image, platform))
    ) {
      return;
    }

    const buildWorkerImage = ora(
      `Building Docker worker image: ${image} (${platform})`,
    ).start();

    try {
      await execa(
        'docker',
        [
          'build',
          '--platform',
          platform,
          '-f',
          'apps/worker/Dockerfile',
          '-t',
          image,
          '.',
        ],
        {
          cwd: rootDir,
          ...(verbose && { stdio: 'inherit' }),
        },
      );
      buildWorkerImage.succeed();
    } catch (error) {
      buildWorkerImage.fail();
      throw error;
    }
  }

  static async stopSelfHostAppContainers(verbose: boolean): Promise<void> {
    const rootDir = path.resolve(process.cwd(), '../..');
    await this.cleanupWorkerContainers(verbose);
    const selfHostContainers =
      await this.getSameCheckoutComposeContainers(rootDir);

    const appContainers = selfHostContainers.filter((container) => {
      const labels = container.Labels ?? {};
      const service = labels['com.docker.compose.service'];

      return service && this.SELF_HOST_APP_SERVICES.includes(service);
    });

    if (appContainers.length === 0) {
      return;
    }

    const names = appContainers
      .flatMap((container) => container.Names)
      .map((name) => name.replace(/^\//, ''));

    const stopSelfHost = ora('Stopping self-host app containers').start();

    for (const name of names) {
      try {
        await execa('docker', ['rm', '-f', name]);
      } catch (error) {
        if (verbose) {
          console.warn(
            `Failed to remove self-host container ${name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    stopSelfHost.succeed();
  }

  static async checkContainers(_verbose: boolean): Promise<void> {
    const checkContainers = ora('Checking Docker containers').start();
    const rootDir = path.resolve(process.cwd(), '../..');

    await this.cleanupLegacyContainers(rootDir);

    let statuses = await this.getContainerStatuses();

    const missing = Object.entries(statuses)
      .filter(([_, isRunning]) => !isRunning)
      .map(([name]) => name);

    if (missing.length === 0) {
      checkContainers.succeed();
      return;
    }

    checkContainers.warn();

    ora(`Starting Docker containers: ${missing.join(', ')}`).info();

    await execa('pnpm', ['infra:up'], {
      stdio: 'inherit',
      cwd: path.resolve(process.cwd(), '../..'),
      env: this.getInfraUpEnv(),
      extendEnv: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // startContainers.succeed();

    const verifyContainers = ora('Verifying Docker containers').start();

    // Verify containers are running after starting them.
    statuses = await this.getContainerStatuses();

    const missingContainers = Object.entries(statuses)
      .filter(([_, isRunning]) => !isRunning)
      .map(([name]) => name);

    if (missingContainers.length > 0) {
      throw new Error(
        `Failed to start containers: ${missingContainers.join(', ')}`,
      );
    }

    verifyContainers.succeed();
  }

  private static getInfraUpEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    for (const key of this.INFRA_UP_ENV_VARS_TO_OMIT) {
      delete env[key];
    }

    return env;
  }

  private static async cleanupLegacyContainers(rootDir: string): Promise<void> {
    try {
      const containers = await this.getSameCheckoutComposeContainers(rootDir);

      const staleContainers = containers
        .filter((container) => {
          const labels = container.Labels ?? {};
          const project = labels['com.docker.compose.project'];
          const service = labels['com.docker.compose.service'];
          const names = container.Names.map((name) => name.replace(/^\//, ''));
          const expectedPublicPort = service
            ? this.EXPECTED_PUBLIC_INFRA_PORTS[service]
            : undefined;
          const hasExpectedPublicPort =
            expectedPublicPort === undefined ||
            (container.Ports ?? []).some(
              (port) =>
                'PublicPort' in port && port.PublicPort === expectedPublicPort,
            );

          return (
            (project !== this.CURRENT_COMPOSE_PROJECT &&
              ((service && this.INFRA_SERVICES.includes(service)) ||
                names.some((name) => this.LEGACY_CONTAINERS.includes(name)))) ||
            (project === this.CURRENT_COMPOSE_PROJECT &&
              service !== undefined &&
              expectedPublicPort !== undefined &&
              !hasExpectedPublicPort)
          );
        })
        .flatMap((container) => container.Names)
        .map((name) => name.replace(/^\//, ''));

      for (const container of staleContainers) {
        try {
          await execa('docker', ['rm', '-f', container]);
        } catch (_error) {
          // The container may have already been removed.
        }
      }
    } catch (_error) {
      // The normal container status check below will report Docker failures.
    }
  }

  private static async cleanupWorkerContainers(
    verbose: boolean,
  ): Promise<void> {
    let stdout = '';

    try {
      const result = await execa('docker', [
        'ps',
        '-a',
        '--filter',
        'name=^/roomote-worker-',
        '--format',
        '{{.Names}}',
      ]);
      stdout = result.stdout ?? '';
    } catch (_error) {
      return;
    }

    const containers = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const container of containers) {
      try {
        await execa('docker', ['rm', '-f', container]);
      } catch (error) {
        if (verbose) {
          console.warn(
            `Failed to remove Docker worker container ${container}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  private static async hasCurrentWorkerImageSchema(
    image: string,
  ): Promise<boolean> {
    try {
      const result = await execa('docker', [
        'image',
        'inspect',
        '--format',
        `{{ index .Config.Labels "${WORKER_IMAGE_SCHEMA_LABEL}" }}`,
        image,
      ]);

      return result.stdout?.trim() === WORKER_IMAGE_SCHEMA_VERSION;
    } catch (_error) {
      return false;
    }
  }

  private static async hasRequiredWorkerImageTools(
    image: string,
    platform: string,
  ): Promise<boolean> {
    try {
      await execa('docker', [
        'run',
        '--rm',
        '--platform',
        platform,
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        'test -x /usr/sbin/ip && /usr/sbin/ip -Version >/dev/null && command -v docker >/dev/null && docker --version >/dev/null && docker compose version >/dev/null',
      ]);
      return true;
    } catch (_error) {
      return false;
    }
  }

  private static async getSameCheckoutComposeContainers(rootDir: string) {
    const docker = new Docker();
    await docker.ping();
    const containers = await docker.listContainers({ all: true });

    return containers.filter((container) => {
      const labels = container.Labels ?? {};

      return labels['com.docker.compose.project.working_dir'] === rootDir;
    });
  }

  private static async getContainerStatuses(): Promise<{
    [key: string]: boolean;
  }> {
    const status: { [key: string]: boolean } = {};

    try {
      const docker = new Docker();
      await docker.ping();
      const containers = await docker.listContainers();

      const runningContainers = containers
        .map((container) => container.Names)
        .flat()
        .map((name) => name.replace(/^\//, '')); // Remove leading slash.

      for (const container of this.REQUIRED_CONTAINERS) {
        status[container] = runningContainers.includes(container);
      }

      return status;
    } catch (error) {
      console.error(
        `Failed to check Docker container status: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );

      throw new Error('Docker not available or not running');
    }
  }
}

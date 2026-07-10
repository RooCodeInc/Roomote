import path from 'path';

import { execa } from 'execa';
import ora from 'ora';

import { ScriptOptions } from '../types';

interface ValidationResult {
  hasErrors: boolean;
  errors: string[];
  warnings: string[];
}

interface ServiceStatus {
  name: string;
  pm_id?: number;
  pid?: number;
  pm2_env: {
    pm_cwd?: string;
    status: string;
    restart_time: number;
    unstable_restarts: number;
  };
}

interface PM2Process {
  name: string;
  pm_id?: number;
  pm2_env: {
    pm_cwd?: string;
    status: string;
    restart_time: number;
    unstable_restarts: number;
  };
}

const LOCAL_SERVICES = [
  'roomote-api',
  'roomote-web',
  'roomote-preview-proxy',
  'roomote-bullmq',
  'roomote-controller',
  'roomote-worker-release-watcher',
];
const OWNED_NGROK_SERVICES = [
  'roomote-api-ngrok',
  'roomote-web-ngrok',
  'roomote-preview-proxy-ngrok',
];
const LEGACY_LOCAL_SERVICES = [
  'api',
  'web',
  'preview-proxy',
  'bullmq',
  'controller',
  'worker-release-watcher',
];
const LEGACY_NGROK_SERVICES = ['api-ngrok', 'web-ngrok', 'preview-proxy-ngrok'];

export class PM2Service {
  public static async prepareServicesForDev(): Promise<void> {
    const prepareServices = ora('Running dev prepare hooks').start();

    const rootDir = path.resolve(process.cwd(), '../..');

    await execa('pnpm', ['-r', '--if-present', 'run', 'dev:prepare'], {
      cwd: rootDir,
    });

    prepareServices.succeed();
  }

  public static async checkInstalled(): Promise<void> {
    const pm2Check = ora('Checking pm2 installation').start();

    try {
      await execa('pm2', ['--version']);
    } catch (_error) {
      console.error('PM2 is not installed. Installing globally...');
      const installPM2 = ora('Installing PM2').start();

      try {
        await execa('npm', ['install', '-g', 'pm2']);
        installPM2.succeed();
      } catch (_installError) {
        throw new Error(
          'Failed to install PM2. Please install it manually: npm install -g pm2',
        );
      }
    }

    pm2Check.succeed();
  }

  public static async stopServices({
    preserveAutoWebNgrok = false,
  }: {
    preserveAutoWebNgrok?: boolean;
  } = {}): Promise<void> {
    const stopServices = ora('Stopping services').start();
    const rootDir = path.resolve(process.cwd(), '../..');
    const statuses = await this.getPM2Status();
    const serviceIds = this.getServicesToStop(statuses, rootDir, {
      preserveAutoWebNgrok,
    });

    for (const serviceId of serviceIds) {
      try {
        await execa('pm2', ['delete', serviceId]);
      } catch (_error) {
        // Service was not running.
      }
    }

    stopServices.succeed();
  }

  public static async startServices(options: ScriptOptions): Promise<void> {
    const startServices = ora(
      `Starting services: ${this.getExpectedServices(options).join(', ')}`,
    ).start();

    const rootDir = path.resolve(process.cwd(), '../..');
    await execa('mkdir', ['-p', 'logs'], { cwd: rootDir });

    await execa('pm2', ['start', 'ecosystem.config.js'], {
      ...(options.verbose && { stdio: 'inherit' }),
      cwd: rootDir,
      env: {
        ...process.env,
        ...(options.publicUrl && {
          ROOMOTE_PUBLIC_URL: options.publicUrl,
          ROOMOTE_APP_URL: options.publicUrl,
        }),
        USE_WORKER_RELEASE: options.useRelease ? 'true' : 'false',
        ...(options.useRelease && {
          WORKER_RELEASE_CHANNEL: options.workerReleaseChannel,
        }),
        ...(options.useRelease &&
          options.workerReleaseVersion && {
            WORKER_RELEASE_VERSION: options.workerReleaseVersion,
          }),
      },
    });

    startServices.succeed();
  }

  public static async validateServices(options: ScriptOptions): Promise<void> {
    const validateServices = ora('Validating services').start();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const statuses = await this.getPM2Status();

    const results = this.validateServiceStatuses(
      this.getExpectedServices(options),
      statuses,
    );

    if (results.hasErrors) {
      validateServices.fail();
      throw new Error(this.formatValidationErrors(results));
    }

    if (results.warnings.length > 0) {
      validateServices.warn();
      results.warnings.forEach((warning) => console.warn(`  ⚠️  ${warning}`));
    } else {
      validateServices.succeed();
    }

    await this.validatePublicEdge(options);
  }

  /**
   * Docker workers call back into the API through the public URL (ngrok →
   * Caddy edge), which can lag behind the local services after a (re)start.
   * Poll the API health route through the edge so jobs launched right after
   * startup don't race a proxy that isn't serving yet.
   */
  private static async validatePublicEdge(
    options: ScriptOptions,
  ): Promise<void> {
    if (!options.publicUrl) {
      return;
    }

    const healthUrl = `${options.publicUrl.replace(/\/+$/, '')}/_roomote-api/`;
    const checkEdge = ora(`Checking public edge at ${healthUrl}`).start();
    const deadline = Date.now() + 45_000;
    let lastFailure = 'no response';

    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5_000),
        });
        const contentType = response.headers.get('content-type') ?? '';

        if (response.ok && contentType.includes('application/json')) {
          checkEdge.succeed();
          return;
        }

        lastFailure = `status ${response.status}, content-type ${contentType || 'missing'}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    checkEdge.warn();
    console.warn(
      `  ⚠️  Public edge did not serve the API health check within 45s (last: ${lastFailure}). Worker callbacks may fail until it settles.`,
    );
  }

  private static getExpectedServices(options: ScriptOptions): string[] {
    let expectedServices = [
      ...LOCAL_SERVICES,
      ...(options.autoNgrok ? ['roomote-web-ngrok'] : []),
    ];

    if (options.useRelease) {
      expectedServices = expectedServices.filter(
        (service) => service !== 'roomote-worker-release-watcher',
      );
    }

    return expectedServices;
  }

  private static async getPM2Status(): Promise<PM2Process[]> {
    try {
      const { stdout } = await execa('pm2', ['--silent', 'jlist']);
      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to get PM2 status:', error);
      return [];
    }
  }

  private static getServicesToStop(
    statuses: PM2Process[],
    rootDir: string,
    {
      preserveAutoWebNgrok,
    }: {
      preserveAutoWebNgrok: boolean;
    },
  ): string[] {
    const namespacedServices = new Set([
      ...LOCAL_SERVICES,
      ...OWNED_NGROK_SERVICES,
    ]);
    const legacyServices = new Set([
      ...LEGACY_LOCAL_SERVICES,
      ...LEGACY_NGROK_SERVICES,
    ]);

    return statuses
      .filter((service) => {
        if (preserveAutoWebNgrok && service.name === 'roomote-web-ngrok') {
          return false;
        }

        if (namespacedServices.has(service.name)) {
          return true;
        }

        return (
          legacyServices.has(service.name) && service.pm2_env.pm_cwd === rootDir
        );
      })
      .map((service) => String(service.pm_id ?? service.name));
  }

  private static validateServiceStatuses(
    expectedServices: string[],
    actualStatuses: ServiceStatus[],
  ): ValidationResult {
    const results: ValidationResult = {
      hasErrors: false,
      errors: [],
      warnings: [],
    };

    for (const serviceName of expectedServices) {
      const serviceStatus = actualStatuses.find((s) => s.name === serviceName);

      if (!serviceStatus) {
        results.hasErrors = true;
        results.errors.push(`Service '${serviceName}' not found in PM2`);
        continue;
      }

      // Check if service is online.
      if (serviceStatus.pm2_env.status !== 'online') {
        results.hasErrors = true;

        results.errors.push(
          `Service '${serviceName}' is ${serviceStatus.pm2_env.status}. ` +
            `Check logs: pm2 logs ${serviceName}`,
        );
      }

      // Check restart count (warning if > 3).
      const restartCount = serviceStatus.pm2_env.restart_time || 0;

      if (restartCount > 3) {
        results.warnings.push(
          `Service '${serviceName}' has restarted ${restartCount} times`,
        );
      }

      // Check if service crashed recently.
      if (serviceStatus.pm2_env.status === 'online' && restartCount > 0) {
        const unstableLimit = serviceStatus.pm2_env.unstable_restarts || 0;

        if (unstableLimit > 0) {
          results.warnings.push(
            `Service '${serviceName}' had ${unstableLimit} unstable restarts`,
          );
        }
      }
    }

    return results;
  }

  private static formatValidationErrors(results: ValidationResult): string {
    let message = 'Service validation failed:\n\n';

    if (results.errors.length > 0) {
      message += 'Errors:\n';
      results.errors.forEach((error) => {
        message += `  ❌ ${error}\n`;
      });
    }

    if (results.warnings.length > 0) {
      message += '\nWarnings:\n';
      results.warnings.forEach((warning) => {
        message += `  ⚠️  ${warning}\n`;
      });
    }

    message += '\nTroubleshooting:\n';
    message += '  1. Check logs: pm2 logs\n';
    message += '  2. Check status: pm2 status\n';
    message += '  3. Restart failed services: pm2 restart [service-name]\n';
    message += '  4. Check port availability\n';
    message += '  5. Ensure all environment variables are set correctly\n';

    return message;
  }
}

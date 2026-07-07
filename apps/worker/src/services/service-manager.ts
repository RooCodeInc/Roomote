import {
  type ServiceConfig,
  type ServiceInfo,
  type ServiceName,
  serviceDefaultPorts,
} from '@roomote/types';

import { CommandExecutor } from '../command-executor';
import type { StartupLogger } from '../logging';
import { timedStep } from '../commands/setup/logging';

import type { ServiceDefinition, ServiceContext } from './types';
import { getServiceDefinition } from './service-definition';

/**
 * ServiceManager - orchestrates installation and startup of services in sandbox
 * environments.
 */
export class ServiceManager {
  constructor(
    readonly cwd: string,
    readonly env: Record<string, string | undefined>,
    private readonly dataDir: string = '/data/services',
    readonly verbose: boolean = false,
  ) {}

  /**
   * Start all specified services, installing them if needed.
   *
   * @param configs - Service configurations to start
   * @param context - Optional context for services that require preview auth-proxy configuration
   */
  async startServices(
    logger: StartupLogger,
    configs: ServiceConfig[],
    context?: ServiceContext,
  ): Promise<ServiceInfo[]> {
    const supportedConfigs = configs.filter((config) => {
      const name = typeof config === 'string' ? config : config.name;

      if (name === 'codeserver') {
        console.warn('Skipping unavailable Code Server service');
        return false;
      }

      return true;
    });

    if (supportedConfigs.length === 0) {
      return [];
    }

    const setupExecutor = new CommandExecutor(this.cwd, this.env, this.verbose);

    // Create the base data directory.
    await setupExecutor.execute({
      name: 'Create services data directory',
      run: `sudo mkdir -p ${this.dataDir} && sudo chown $(whoami) ${this.dataDir}`,
      timeout: 30,
      continue_on_error: false,
    });

    // Resolve all service configs up front.
    const resolved = supportedConfigs.map((config) => {
      const { name, port } = this.normalizeConfig(config);
      const definition = getServiceDefinition(name);
      const actualPort = port ?? definition.defaultPort;
      return { name, definition, actualPort };
    });

    // Install concurrently so service-specific preflight checks and
    // non-package-manager setup can overlap. Definitions still serialize apt
    // work internally via the shared package-manager lock helpers.
    await Promise.all(
      resolved.map(async ({ name, definition }) => {
        const executor = new CommandExecutor(this.cwd, this.env, this.verbose);
        console.log(`Installing and starting ${name}`);

        await timedStep(logger, `install ${name}`, () =>
          definition.install(executor),
        );
      }),
    );

    // Start and health-check all services concurrently.
    return Promise.all(
      resolved.map(async ({ name, definition, actualPort }) => {
        try {
          const result = await timedStep(logger, `start ${name}`, () =>
            this.startService(name, definition, actualPort, context),
          );

          return result;
        } catch (error) {
          console.error(
            `Failed to start ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );

          throw error;
        }
      }),
    );
  }

  /**
   * Start a single service.
   */
  private async startService(
    name: ServiceName,
    definition: ServiceDefinition,
    port: number,
    context?: ServiceContext,
  ): Promise<ServiceInfo> {
    const executor = new CommandExecutor(this.cwd, this.env, this.verbose);

    if (port > 0) {
      console.log(`Starting ${name} on port ${port}`);
      let verifiedManagedInstanceAfterError = false;

      try {
        await definition.start(executor, port, context);
      } catch (error) {
        verifiedManagedInstanceAfterError = definition.verifyManagedInstance
          ? await definition.verifyManagedInstance(port)
          : false;

        if (verifiedManagedInstanceAfterError) {
          console.log(
            `${name} verified its managed instance after a start error, continuing`,
          );
        } else {
          throw error;
        }
      }

      if (
        definition.verifyManagedInstance &&
        !verifiedManagedInstanceAfterError
      ) {
        const ownsManagedInstance =
          await definition.verifyManagedInstance(port);

        if (!ownsManagedInstance) {
          throw new Error(
            `${name} did not start the managed service instance on port ${port}`,
          );
        }
      }
    }

    await this.waitForHealthy(name, definition, port);

    const { connectionString, envVars } = definition.getConnectionInfo(port);

    return {
      name,
      port,
      host: 'localhost',
      connectionString,
      envVars,
    };
  }

  /**
   * Wait for a service to become healthy.
   */
  private async waitForHealthy(
    name: ServiceName,
    definition: ServiceDefinition,
    port: number,
    maxAttempts = 30,
    intervalMs = 1000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await definition.healthCheck(port)) {
        console.log(`Successfully installed and verified ${name}`);
        return;
      }

      console.log(
        `Waiting for ${name} to be ready... (${i + 1}/${maxAttempts})`,
      );

      await this.sleep(intervalMs);
    }

    throw new Error(
      `${name} failed to become healthy after ${maxAttempts} attempts`,
    );
  }

  /**
   * Normalize a ServiceConfig to { name, port } format.
   */
  private normalizeConfig(config: ServiceConfig): {
    name: ServiceName;
    port?: number;
  } {
    if (typeof config === 'string') {
      return { name: config, port: serviceDefaultPorts[config] };
    }

    return { name: config.name, port: config.port };
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get combined environment variables from all started services.
   */
  static getEnvVars(services: ServiceInfo[]): Record<string, string> {
    const envVars: Record<string, string> = {};

    for (const service of services) {
      Object.assign(envVars, service.envVars);
    }

    return envVars;
  }
}

import { execa } from 'execa';

import { withAptLock } from '../commands/setup/package-manager';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

/**
 * Creates a Redis service definition for the specified major version on the
 * Ubuntu-based worker runtime.
 */
export function createRedisService(majorVersion: string): ServiceDefinition {
  const isValkey = majorVersion === '7';
  const rawConfig = isValkey ? SERVICE_CONFIG.redis7 : SERVICE_CONFIG.redis6;
  const displayName = isValkey
    ? `Valkey (Redis ${majorVersion} compatible)`
    : `Redis ${majorVersion}`;
  const pidFile = `${rawConfig.dataDir}/${isValkey ? 'valkey' : 'redis'}.pid`;
  const healthCheck = async (port: number) => {
    try {
      const result = await execa(
        rawConfig.cliBinary,
        ['-p', String(port), 'ping'],
        { timeout: 5000 },
      );

      return result.stdout.trim() === 'PONG';
    } catch {
      return false;
    }
  };
  const readConfigValue = async (port: number, key: string) => {
    const result = await execa(
      rawConfig.cliBinary,
      ['--raw', '-p', String(port), 'CONFIG', 'GET', key],
      { timeout: 5000 },
    );

    const [, value = ''] = result.stdout.trim().split('\n');
    return value.trim();
  };

  return {
    defaultPort: rawConfig.defaultPort,

    async install(executor) {
      // Check if Redis/Valkey is already installed (e.g., from a snapshot).
      const versionResult = await executor.execute({
        name: `Check installed ${displayName} version`,
        run: `${rawConfig.serverBinary} --version 2>/dev/null || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      if (!versionResult.stdout?.includes('not_installed')) {
        return;
      }

      await withAptLock(() =>
        executor.execute({
          name: `Install ${displayName}`,
          run: `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${rawConfig.packageName}`,
          // Package installs can legitimately exceed three minutes on slow
          // mirrors, and aborting here fails the whole sandbox bootstrap.
          timeout: 300,
          continue_on_error: false,
        }),
      );
    },

    async start(executor, port) {
      await executor.execute({
        name: 'Create Redis data directory',
        run: `mkdir -p ${rawConfig.dataDir}`,
        timeout: 30,
        continue_on_error: false,
      });

      // Stop any distro-managed Redis/Valkey instance before starting our own.
      await executor.execute({
        name: 'Stop auto-started Redis',
        run: `sudo systemctl stop valkey 2>/dev/null || sudo service valkey stop 2>/dev/null || true; sudo systemctl stop redis-server 2>/dev/null || sudo service redis-server stop 2>/dev/null || true; sudo systemctl stop redis 2>/dev/null || sudo service redis stop 2>/dev/null || true; sudo systemctl stop redis6 2>/dev/null || sudo service redis6 stop 2>/dev/null || true`,
        timeout: 30,
        continue_on_error: true,
      });

      await executor.execute({
        name: 'Stop Redis instance on target port',
        run: `${rawConfig.cliBinary} -p ${port} shutdown nosave 2>/dev/null || true; for i in {1..10}; do ! ${rawConfig.cliBinary} -p ${port} ping >/dev/null 2>&1 && break || sleep 1; done`,
        timeout: 30,
        continue_on_error: true,
      });

      await executor.execute({
        name: 'Clean up stale Redis PID file',
        run: `rm -f ${pidFile}`,
        timeout: 30,
        continue_on_error: true,
      });

      await executor.execute({
        name: `Start ${displayName}`,
        run: `${rawConfig.serverBinary} --daemonize yes --port ${port} --dir ${rawConfig.dataDir} --pidfile ${pidFile}`,
        timeout: 30,
        continue_on_error: false,
      });

      await executor.execute({
        name: `Wait for ${displayName} to be ready`,
        run: `for i in {1..30}; do ${rawConfig.cliBinary} -p ${port} ping && break || sleep 1; done`,
        timeout: 60,
        continue_on_error: false,
      });
    },

    healthCheck,

    async verifyManagedInstance(port) {
      try {
        if (!(await healthCheck(port))) {
          return false;
        }

        const infoResult = await execa(
          rawConfig.cliBinary,
          ['-p', String(port), 'INFO', 'server'],
          { timeout: 5000 },
        );
        const processId = infoResult.stdout.match(/^process_id:(\d+)$/m)?.[1];
        const configuredDataDir = await readConfigValue(port, 'dir');
        const configuredPidFile = await readConfigValue(port, 'pidfile');

        if (!processId || configuredDataDir !== rawConfig.dataDir) {
          return false;
        }

        if (configuredPidFile !== pidFile) {
          return false;
        }

        const processDetails = await execa(
          'ps',
          ['-p', processId, '-o', 'stat=', '-o', 'comm='],
          { timeout: 5000 },
        );
        const [stat = '', command = ''] = processDetails.stdout
          .trim()
          .split(/\s+/, 2);

        return !stat.startsWith('Z') && command === rawConfig.serverBinary;
      } catch {
        return false;
      }
    },

    getConnectionInfo(port) {
      return {
        connectionString: `redis://localhost:${port}`,
        envVars: {
          REDIS_URL: `redis://localhost:${port}`,
          REDIS_HOST: 'localhost',
          REDIS_PORT: String(port),
        },
      };
    },
  };
}

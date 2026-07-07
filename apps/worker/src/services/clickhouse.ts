import { execa } from 'execa';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

const CONFIG = SERVICE_CONFIG.clickhouse as {
  defaultPort: number;
  httpPort: number;
  installDir: string;
};

export function createClickhouseService(): ServiceDefinition {
  const { defaultPort, httpPort, installDir } = CONFIG;
  const clickhouseDataDir = '/var/lib/clickhouse';

  return {
    defaultPort,

    async install(executor) {
      const versionResult = await executor.execute({
        name: 'Check installed ClickHouse version',
        run: `${installDir}/clickhouse client --version 2>/dev/null || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      if (!versionResult.stdout?.includes('not_installed')) {
        return;
      }

      await executor.execute({
        name: 'Create ClickHouse install directory',
        run: `mkdir -p ${installDir}`,
        timeout: 30,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Download ClickHouse installer',
        run: `curl https://clickhouse.com/ | sh`,
        cwd: installDir,
        timeout: 120,
        continue_on_error: false,
      });
    },

    async start(executor, _port) {
      // Set the default user password to match .env.test (CLICKHOUSE_PASSWORD=password).
      // The installer creates a random password, which we need to override.
      await executor.execute({
        name: 'Configure ClickHouse',
        run: `sudo bash -c 'echo "<clickhouse><http_port>${CONFIG.httpPort}</http_port><tcp_port>${CONFIG.defaultPort}</tcp_port><profiles><default></default></profiles><users><default><password>password</password></default></users></clickhouse>" > config.xml'`,
        cwd: installDir,
        timeout: 30,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Create ClickHouse runtime directories',
        run: `sudo mkdir -p ${clickhouseDataDir} && sudo chown -R root:root ${installDir}`,
        timeout: 30,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Clean up stale ClickHouse status file',
        run: `sudo rm -f ${clickhouseDataDir}/status ${clickhouseDataDir}/status.tmp`,
        timeout: 30,
        continue_on_error: true,
      });

      // Start ClickHouse directly as root (bypassing the start script that
      // uses sudo -u clickhouse).
      // The standard `sudo clickhouse start` fails in Docker containers due to
      // PAM issues.
      // Note: We run in foreground with nohup and redirect output since the
      // --daemon flag doesn't work well in this container environment.
      // Using bash -c to ensure the redirect happens under sudo.
      await executor.execute({
        name: 'Start ClickHouse',
        // run: `sudo ./clickhouse server`,
        run: `sudo bash -c 'nohup ./clickhouse server -C config.xml > server.log 2>&1 &'`,
        cwd: installDir,
        timeout: 60,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Wait for ClickHouse to be ready',
        run: `for i in {1..30}; do ${installDir}/clickhouse client --password password --query "SELECT 1" 2>/dev/null && break || sleep 1; done`,
        timeout: 60,
        continue_on_error: false,
      });
    },

    async healthCheck(_port) {
      try {
        await execa(
          `${installDir}/clickhouse`,
          ['client', '--password', 'password', '--query', 'SELECT 1'],
          { timeout: 5000 },
        );

        return true;
      } catch {
        return false;
      }
    },

    getConnectionInfo(port) {
      // Use HTTP port for CLICKHOUSE_URL since many clients (including test
      // suites) expect the HTTP interface.
      // The native TCP port is also provided as CLICKHOUSE_TCP_PORT.
      return {
        connectionString: `http://localhost:${httpPort}`,
        envVars: {
          CLICKHOUSE_URL: `http://localhost:${httpPort}`,
          CLICKHOUSE_HOST: 'localhost',
          CLICKHOUSE_PORT: String(httpPort),
          CLICKHOUSE_TCP_PORT: String(port),
          CLICKHOUSE_DATABASE: 'default',
        },
      };
    },
  };
}

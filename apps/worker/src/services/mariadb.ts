import { execa } from 'execa';

import { withAptLock } from '../commands/setup/package-manager';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

const MARIADB_LOG_FILE = '/tmp/mariadb-start.log';
const MARIADB_PID_FILE = '/data/services/mysql/mariadb.pid';

function buildMariadbStartCommand({
  dataDir,
  socketPath,
  port,
}: {
  dataDir: string;
  socketPath: string;
  port: number;
}) {
  const args = [
    'mariadbd',
    '--user=mysql',
    `--datadir=${dataDir}`,
    `--port=${port}`,
    '--bind-address=0.0.0.0',
    `--socket=${socketPath}`,
    `--pid-file=${MARIADB_PID_FILE}`,
  ];

  return `sudo ${args.join(' ')}`;
}

/**
 * Creates a MariaDB service definition.
 *
 * Ubuntu-based workers install `mariadb-server` from apt.
 */
export function createMariadbService(_majorVersion: string): ServiceDefinition {
  const config = SERVICE_CONFIG.mariadb10;

  return {
    defaultPort: config.defaultPort,

    async install(executor) {
      // Check if MariaDB is already installed (e.g., from a snapshot).
      const versionResult = await executor.execute({
        name: 'Check installed MariaDB version',
        run: `mysql --version 2>/dev/null || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      const serverResult = await executor.execute({
        name: 'Check MariaDB server tools',
        run: `command -v mariadbd >/dev/null 2>&1 && (command -v mariadb-install-db >/dev/null 2>&1 || command -v mysql_install_db >/dev/null 2>&1) && echo "server_tools_installed" || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      const clientInstalled = !versionResult.stdout?.includes('not_installed');
      const serverInstalled = serverResult.stdout?.includes(
        'server_tools_installed',
      );

      if (clientInstalled && serverInstalled) {
        // Still ensure data directory exists with correct ownership.
        await executor.execute({
          name: 'Ensure MariaDB data directory',
          run: `sudo mkdir -p ${config.dataDir} && sudo chown -R mysql:mysql ${config.dataDir}`,
          timeout: 60,
          continue_on_error: false,
        });

        return;
      }

      const installCmd = `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${config.packageName}`;

      await withAptLock(() =>
        executor.execute({
          name: `Install MariaDB`,
          run: `${installCmd} && sudo mkdir -p ${config.dataDir} && sudo chown -R mysql:mysql ${config.dataDir}`,
          timeout: 300,
          continue_on_error: false,
        }),
      );
    },

    async start(executor, port) {
      await executor.execute({
        name: 'Stop auto-started MariaDB services',
        run: `sudo systemctl stop mariadb 2>/dev/null || sudo service mariadb stop 2>/dev/null || sudo systemctl stop mysql 2>/dev/null || sudo service mysql stop 2>/dev/null || true`,
        timeout: 30,
        continue_on_error: true,
      });

      // Initialize MariaDB data directory if needed.
      await executor.execute({
        name: 'Initialize MariaDB data directory',
        run: `[ -d "${config.dataDir}/mysql" ] || (command -v mariadb-install-db >/dev/null 2>&1 && sudo mariadb-install-db --user=mysql --datadir=${config.dataDir} || sudo mysql_install_db --user=mysql --datadir=${config.dataDir})`,
        timeout: 120,
        continue_on_error: false,
      });

      // Ensure data directory has correct ownership (fixes permission issues after init).
      await executor.execute({
        name: 'Fix MariaDB data directory ownership',
        run: `sudo chown -R mysql:mysql ${config.dataDir}`,
        timeout: 60,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Clean up stale MariaDB files',
        run: `sudo rm -f ${config.socketPath} ${config.socketPath}.lock ${MARIADB_PID_FILE} ${config.dataDir}/*.pid 2>/dev/null || true`,
        timeout: 10,
        continue_on_error: true,
      });

      await executor.execute({
        name: 'Start MariaDB',
        run: buildMariadbStartCommand({
          dataDir: config.dataDir,
          socketPath: config.socketPath,
          port,
        }),
        detached: true,
        logfile: MARIADB_LOG_FILE,
        timeout: 30,
        continue_on_error: false,
      });

      // Wait for the server to start.
      await executor.execute({
        name: 'Wait for MariaDB to start',
        run: `sleep 3 && for i in {1..30}; do sudo mysqladmin --protocol=socket --socket=${config.socketPath} ping -u root 2>/dev/null && break || sleep 1; done`,
        timeout: 60,
        continue_on_error: false,
      });

      // Configure passwordless root access (switch from unix_socket to mysql_native_password).
      await executor.execute({
        name: 'Configure passwordless root access',
        run: `sudo mysql --protocol=socket --socket=${config.socketPath} -e "ALTER USER 'root'@'localhost' IDENTIFIED VIA mysql_native_password USING '';"`,
        timeout: 30,
        continue_on_error: true, // May fail on snapshot restore if already configured.
      });

      // Create root user for remote connections with full privileges.
      await executor.execute({
        name: 'Create root user for remote connections',
        run: `sudo mysql --protocol=socket --socket=${config.socketPath} -e "CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY ''; GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION; FLUSH PRIVILEGES;"`,
        timeout: 30,
        continue_on_error: true, // May fail on snapshot restore if already configured.
      });
    },

    async healthCheck(_port) {
      try {
        await execa(
          'mysqladmin',
          [
            '--protocol=socket',
            `--socket=${config.socketPath}`,
            '-u',
            'root',
            'ping',
          ],
          { timeout: 5000 },
        );
        return true;
      } catch {
        return false;
      }
    },

    getConnectionInfo(port) {
      return {
        connectionString: `mysql://root@localhost:${port}`,
        envVars: {
          MYSQL_URL: `mysql://root@localhost:${port}`,
          MYSQL_HOST: 'localhost',
          MYSQL_PORT: String(port),
          MYSQL_USER: 'root',
          MYSQL_SOCKET: config.socketPath,
        },
      };
    },
  };
}

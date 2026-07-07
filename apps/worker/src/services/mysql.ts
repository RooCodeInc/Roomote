import { execa } from 'execa';

import { withAptLock } from '../commands/setup/package-manager';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

const MYSQL_LOG_FILE = '/tmp/mysql8.log';
const MYSQL_PID_FILE = '/tmp/mysql8.pid';
const MYSQL_SECURE_FILE_PRIV_DIR = '/var/lib/mysql-files';
const MYSQL_APT_KEYRING_DIR = '/usr/share/keyrings';
const MYSQL_APT_KEYRING_PATH = `${MYSQL_APT_KEYRING_DIR}/mysql.gpg`;
const MYSQL_APT_SOURCE_PATH = '/etc/apt/sources.list.d/mysql.list';
const MYSQL_APT_REPO = 'https://repo.mysql.com/apt/debian/';
const MYSQL_APT_COMPONENT = 'mysql-8.0';
const MYSQL_NATIVE_APT_CLIENT_PACKAGE = 'mysql-client';
const MYSQL_NATIVE_APT_SERVER_PACKAGE = 'mysql-server-core-8.0';
const MYSQL_REPO_SUPPORTED_CODENAMES = [
  'trixie',
  'bookworm',
  'bullseye',
  'buster',
];
const MYSQL_REPO_DEFAULT_CODENAME = 'bookworm';

function buildMysqlAptInstallCommand(): string {
  const supported = MYSQL_REPO_SUPPORTED_CODENAMES.join(' ');

  // Written as a readable shell script. The native-package path is tried
  // first (Ubuntu 24.04+); the MySQL Community repo is the fallback for
  // Debian hosts that don't ship native MySQL packages.
  return `\
sudo apt-get update && \
if apt-cache show ${MYSQL_NATIVE_APT_CLIENT_PACKAGE} >/dev/null 2>&1 \
   && apt-cache show ${MYSQL_NATIVE_APT_SERVER_PACKAGE} >/dev/null 2>&1; then \
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${MYSQL_NATIVE_APT_CLIENT_PACKAGE} ${MYSQL_NATIVE_APT_SERVER_PACKAGE}; \
else \
  MYSQL_REPO_DISTRO="${MYSQL_REPO_DEFAULT_CODENAME}"; \
  if [ -f /etc/os-release ]; then \
    . /etc/os-release; \
    for distro in ${supported}; do \
      if [ "\${VERSION_CODENAME:-}" = "$distro" ]; then MYSQL_REPO_DISTRO="$distro"; break; fi; \
    done; \
  fi; \
  sudo install -d -m 0755 ${MYSQL_APT_KEYRING_DIR} /etc/apt/sources.list.d && \
  curl -fsSL https://repo.mysql.com/RPM-GPG-KEY-mysql-2023 | gpg --dearmor | sudo tee ${MYSQL_APT_KEYRING_PATH} >/dev/null && \
  echo "deb [signed-by=${MYSQL_APT_KEYRING_PATH}] ${MYSQL_APT_REPO} \${MYSQL_REPO_DISTRO} ${MYSQL_APT_COMPONENT}" | sudo tee ${MYSQL_APT_SOURCE_PATH} >/dev/null && \
  sudo apt-get update && \
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-community-server; \
fi`;
}

function buildMysqlStartCommand({
  dataDir,
  socketPath,
  port,
  skipGrantTables,
}: {
  dataDir: string;
  socketPath: string;
  port: number;
  skipGrantTables: boolean;
}) {
  const args = [
    'mysqld',
    '--user=mysql',
    `--datadir=${dataDir}`,
    `--port=${port}`,
    '--bind-address=0.0.0.0',
    `--socket=${socketPath}`,
    `--pid-file=${MYSQL_PID_FILE}`,
    ...(skipGrantTables ? ['--skip-grant-tables'] : []),
  ];

  return `sudo ${args.join(' ')}`;
}

function buildMysqlBootstrapCommand(dataDir: string) {
  return [
    'sudo getent group mysql >/dev/null 2>&1 || sudo groupadd --system mysql',
    'id -u mysql >/dev/null 2>&1 || sudo useradd --system --gid mysql --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin mysql',
    `sudo install -d -o mysql -g mysql -m 0750 ${dataDir}`,
    `sudo install -d -o mysql -g mysql -m 0750 ${MYSQL_SECURE_FILE_PRIV_DIR}`,
  ].join('; ');
}

/**
 * Creates a MySQL 8 Community Server service definition.
 * Uses MySQL's default paths (/var/lib/mysql) to avoid permission issues.
 *
 * - **apt (Ubuntu)**: Native `mysql-client` + `mysql-server-core-8.0` packages,
 *   with explicit worker-managed bootstrap of the `mysql` system user and
 *   datadir because the full `mysql-server-8.0` postinst is not reliable in
 *   headless worker environments.
 * - **apt (Debian)**: MySQL Community apt repo + `mysql-community-server`.
 */
export function createMysqlService(_majorVersion: string): ServiceDefinition {
  const config = SERVICE_CONFIG.mysql8;

  return {
    defaultPort: config.defaultPort,

    async install(executor) {
      // Check if MySQL 8 Community Server is fully installed.
      const versionResult = await executor.execute({
        name: 'Check installed MySQL version',
        run: `mysql --version 2>/dev/null | grep -q "8.0" && command -v mysqld >/dev/null 2>&1 && echo "mysql8_installed" || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      if (versionResult.stdout?.includes('mysql8_installed')) {
        return;
      }

      await withAptLock(() =>
        executor.execute({
          name: 'Install MySQL 8 Server',
          run: buildMysqlAptInstallCommand(),
          timeout: 600,
          continue_on_error: false,
        }),
      );
    },

    async start(executor, port) {
      // The apt-installed packages do not reliably leave behind a worker-ready
      // mysql system user or datadir, so bootstrap them explicitly.
      await executor.execute({
        name: 'Ensure MySQL system user and data directory',
        run: buildMysqlBootstrapCommand(config.dataDir),
        timeout: 60,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Stop auto-started MySQL services',
        run: `sudo systemctl stop mysql 2>/dev/null || sudo service mysql stop 2>/dev/null || sudo systemctl stop mariadb 2>/dev/null || sudo service mariadb stop 2>/dev/null || true`,
        timeout: 30,
        continue_on_error: true,
      });

      // Initialize MySQL data directory only when it is empty. Ubuntu's
      // native packages may pre-create files directly under /var/lib/mysql
      // without the old nested directory sentinel.
      await executor.execute({
        name: 'Initialize MySQL data directory',
        run: `sudo find ${config.dataDir} -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q . || sudo mysqld --initialize-insecure --user=mysql`,
        timeout: 300,
        continue_on_error: false,
      });

      await executor.execute({
        name: 'Fix MySQL data directory ownership',
        run: `sudo chown -R mysql:mysql ${config.dataDir}`,
        timeout: 60,
        continue_on_error: false,
      });

      // Clean up stale socket/pid files.
      await executor.execute({
        name: 'Clean up stale files',
        run: `sudo rm -f ${config.socketPath} ${config.socketPath}.lock ${MYSQL_PID_FILE} ${config.dataDir}/*.pid 2>/dev/null || true`,
        timeout: 10,
        continue_on_error: true,
      });

      await executor.execute({
        name: 'Start MySQL',
        run: buildMysqlStartCommand({
          dataDir: config.dataDir,
          socketPath: config.socketPath,
          port,
          skipGrantTables: true,
        }),
        detached: true,
        logfile: MYSQL_LOG_FILE,
        timeout: 60,
        continue_on_error: false,
      });

      // Wait for MySQL to start.
      await executor.execute({
        name: 'Wait for MySQL to start',
        run: `for i in {1..30}; do sudo mysqladmin --protocol=socket --socket=${config.socketPath} ping -u root 2>/dev/null && break || sleep 1; done`,
        timeout: 60,
        continue_on_error: false,
      });

      // Configure root user for passwordless access.
      await executor.execute({
        name: 'Configure root user',
        run: `sudo mysql --protocol=socket --socket=${config.socketPath} -u root -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY ''; CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY ''; GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION; GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION; FLUSH PRIVILEGES;"`,
        timeout: 60,
        continue_on_error: true,
      });

      // Restart MySQL.
      await executor.execute({
        name: 'Restart MySQL',
        run: `sudo pkill -9 mysqld 2>/dev/null || true; sleep 2; sudo rm -f ${config.socketPath} ${config.socketPath}.lock ${MYSQL_PID_FILE} ${config.dataDir}/*.pid 2>/dev/null || true; ${buildMysqlStartCommand(
          {
            dataDir: config.dataDir,
            socketPath: config.socketPath,
            port,
            skipGrantTables: false,
          },
        )}`,
        detached: true,
        logfile: MYSQL_LOG_FILE,
        timeout: 60,
        continue_on_error: false,
      });

      // Wait for restart.
      await executor.execute({
        name: 'Wait for MySQL to restart',
        run: `for i in {1..30}; do sudo mysqladmin --protocol=socket --socket=${config.socketPath} ping -u root 2>/dev/null && break || sleep 1; done`,
        timeout: 60,
        continue_on_error: false,
      });
    },

    async healthCheck(_port) {
      try {
        await execa(
          'sudo',
          [
            'mysqladmin',
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

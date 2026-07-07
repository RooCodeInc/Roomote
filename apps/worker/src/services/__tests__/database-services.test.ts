import type { Command } from '@roomote/types';

import { ExecutionError, type CommandExecutor } from '../../command-executor';

import { createAwsService } from '../aws';
import { createMariadbService } from '../mariadb';
import { createMysqlService } from '../mysql';
import { createPostgresService } from '../postgres';
import { createRedisService } from '../redis';
import { createClickhouseService } from '../clickhouse';

type ExecuteCall = Command;

function createExecutorMock() {
  const execute = vi.fn().mockImplementation(async (_command: ExecuteCall) => ({
    stdout: '',
    stderr: '',
  }));

  return {
    execute,
    runs: () => execute.mock.calls.map(([command]) => command as ExecuteCall),
  } as unknown as CommandExecutor & {
    execute: ReturnType<typeof vi.fn>;
    runs: () => ExecuteCall[];
  };
}

describe('database service startup commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs mysql8 on apt trying native packages first with a community-repo fallback', async () => {
    const executor = createExecutorMock();

    await createMysqlService('8').install(executor);

    const installRun = executor
      .runs()
      .find((c) => c.name === 'Install MySQL 8 Server')?.run;
    expect(installRun).toBeDefined();

    // Native package branch
    expect(installRun).toContain('apt-cache show mysql-client');
    expect(installRun).toContain('apt-cache show mysql-server-core-8.0');
    expect(installRun).toContain(
      'apt-get install -y mysql-client mysql-server-core-8.0',
    );

    // Community repo fallback branch
    expect(installRun).toContain(
      'curl -fsSL https://repo.mysql.com/RPM-GPG-KEY-mysql-2023 | gpg --dearmor',
    );
    expect(installRun).toContain(
      'https://repo.mysql.com/apt/debian/ ${MYSQL_REPO_DISTRO} mysql-8.0',
    );
    expect(installRun).toContain('apt-get install -y mysql-community-server');

    // The two branches are gated behind an if/else — verify the structure
    const nativeIdx = installRun!.indexOf('apt-get install -y mysql-client');
    const communityIdx = installRun!.indexOf(
      'apt-get install -y mysql-community-server',
    );
    const elseIdx = installRun!.indexOf('else');
    expect(elseIdx).toBeGreaterThan(nativeIdx);
    expect(communityIdx).toBeGreaterThan(elseIdx);
  });

  it('accepts prebaked aws cli installations', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check installed AWS CLI version') {
        return {
          stdout: 'aws-cli/2.31.29 Python/3.13.7 Linux/6.8 botocore/2.0.0\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createAwsService().install(executor);

    expect(executor.runs()).toEqual([
      expect.objectContaining({
        name: 'Check installed AWS CLI version',
        run: 'command -v aws >/dev/null 2>&1 && aws --version | grep -q \'^aws-cli/2\' && aws --version || echo "not_installed"',
      }),
    ]);
  });

  it('treats aws cli v1 as missing and falls back to a runtime install', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check installed AWS CLI version') {
        return {
          stdout: 'not_installed\n',
          stderr: '',
        };
      }

      if (command.name === 'Verify installed AWS CLI version') {
        return {
          stdout: 'aws-cli/2.31.29 Python/3.13.7 Linux/6.8 botocore/2.0.0\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createAwsService().install(executor);

    expect(executor.runs().map((command) => command.name)).toEqual([
      'Check installed AWS CLI version',
      'Install AWS CLI prerequisites',
      'Install AWS CLI',
      'Verify installed AWS CLI version',
    ]);
  });

  it('installs aws cli at runtime when an older worker image is missing it', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check installed AWS CLI version') {
        return {
          stdout: 'not_installed\n',
          stderr: '',
        };
      }

      if (command.name === 'Verify installed AWS CLI version') {
        return {
          stdout: 'aws-cli/2.31.29 Python/3.13.7 Linux/6.8 botocore/2.0.0\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createAwsService().install(executor);

    expect(executor.runs()).toEqual([
      expect.objectContaining({
        name: 'Check installed AWS CLI version',
      }),
      expect.objectContaining({
        name: 'Install AWS CLI prerequisites',
        run: 'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip',
      }),
      expect.objectContaining({
        name: 'Install AWS CLI',
      }),
      expect.objectContaining({
        name: 'Verify installed AWS CLI version',
      }),
    ]);

    const installRun = executor
      .runs()
      .find((command) => command.name === 'Install AWS CLI')?.run;

    expect(installRun).toContain(
      'https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip',
    );
    expect(installRun).toContain(
      'sudo /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update',
    );
    expect(installRun).toContain("aws --version | grep -q '^aws-cli/2'");
  });

  it('still fails with image rebuild guidance if aws install fallback does not take', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (
        command.name === 'Check installed AWS CLI version' ||
        command.name === 'Verify installed AWS CLI version'
      ) {
        return {
          stdout: 'not_installed\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await expect(createAwsService().install(executor)).rejects.toThrow(
      'AWS CLI is not installed in this worker image. Rebuild and republish the worker base image from apps/worker/Dockerfile before using the aws managed service.',
    );
  });

  it('installs postgres on apt without prompting when the PGDG key already exists', async () => {
    const executor = createExecutorMock();

    await createPostgresService('15').install(executor);

    const addRepoCommand = executor
      .runs()
      .find((command) => command.name === 'Add PostgreSQL APT repository');

    expect(addRepoCommand).toBeDefined();
    expect(addRepoCommand?.timeout).toBe(240);
    expect(addRepoCommand?.run).toContain(
      'apt-get install -y gnupg2 lsb-release',
    );
    expect(addRepoCommand?.run).toContain(
      'gpg --batch --yes --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg',
    );
    expect(addRepoCommand?.run).toContain('apt.postgresql.org/pub/repos/apt');
    expect(addRepoCommand?.run).toContain(
      "Dir::Etc::sourcelist='sources.list.d/pgdg.list'",
    );
  });

  it('reuses prebaked postgres image binaries before falling back to apt installs', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check prebaked PostgreSQL 15 binaries') {
        return {
          stdout: 'prebaked\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createPostgresService('15').install(executor);

    const commandNames = executor.runs().map((command) => command.name);

    expect(commandNames).toEqual([
      'Check prebaked PostgreSQL 15 binaries',
      'Ensure PostgreSQL 15 prerequisites',
      'Symlink PostgreSQL binaries to /usr/local/bin',
      'Stop auto-started PostgreSQL cluster',
    ]);

    const symlinkRun = executor
      .runs()
      .find(
        (command) =>
          command.name === 'Symlink PostgreSQL binaries to /usr/local/bin',
      )?.run;

    expect(symlinkRun).toContain('/usr/lib/postgresql/15/bin/$bin');
  });

  it('installs mariadb on apt when only the mysql client is present', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check installed MariaDB version') {
        return {
          stdout: '/usr/bin/mysql\n',
          stderr: '',
        };
      }

      if (command.name === 'Check MariaDB server tools') {
        return {
          stdout: 'not_installed',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createMariadbService('10').install(executor);

    const installRun = executor
      .runs()
      .find((command) => command.name === 'Install MariaDB')?.run;

    expect(installRun).toBeDefined();
    expect(installRun).toContain('apt-get update -qq');
    expect(installRun).toContain('apt-get install -y mariadb-server');
    expect(installRun).toContain('mkdir -p /data/services/mysql');
  });

  it('refreshes apt metadata before installing redis on standalone workers', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (
        command.name === 'Check installed Valkey (Redis 7 compatible) version'
      ) {
        return {
          stdout: 'not_installed\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createRedisService('7').install(executor);

    const installCommand = executor
      .runs()
      .find(
        (command) => command.name === 'Install Valkey (Redis 7 compatible)',
      );

    expect(installCommand).toBeDefined();
    expect(installCommand?.timeout).toBe(300);
    expect(installCommand?.run).toContain('apt-get update -qq');
    expect(installCommand?.run).toContain('apt-get install -y redis-server');
  });

  it('starts mariadb10 on apt with explicit socket arguments instead of config-file writes', async () => {
    const executor = createExecutorMock();

    await createMariadbService('10').start(executor, 3308);

    const runs = executor.runs().map((command) => command.run);
    const startCommand = executor
      .runs()
      .find((command) => command.name === 'Start MariaDB');

    expect(runs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('systemctl stop mariadb'),
        expect.stringContaining(
          'command -v mariadb-install-db >/dev/null 2>&1 && sudo mariadb-install-db --user=mysql --datadir=/data/services/mysql',
        ),
        expect.stringContaining(
          'sudo mariadbd --user=mysql --datadir=/data/services/mysql --port=3308 --bind-address=0.0.0.0 --socket=/tmp/mysql.sock --pid-file=/data/services/mysql/mariadb.pid',
        ),
        expect.stringContaining(
          'mysqladmin --protocol=socket --socket=/tmp/mysql.sock ping -u root',
        ),
      ]),
    );
    expect(startCommand).toEqual(
      expect.objectContaining({
        detached: true,
        logfile: '/tmp/mariadb-start.log',
      }),
    );
    expect(runs.some((run) => run.includes('/etc/my.cnf.d'))).toBe(false);
  });

  it('starts mysql8 on apt without relying on distro-specific config paths', async () => {
    const executor = createExecutorMock();

    await createMysqlService('8').start(executor, 3307);

    const runs = executor.runs().map((command) => command.run);
    const startCommand = executor
      .runs()
      .find((command) => command.name === 'Start MySQL');
    const restartCommand = executor
      .runs()
      .find((command) => command.name === 'Restart MySQL');

    expect(runs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('getent group mysql'),
        expect.stringContaining('useradd --system --gid mysql'),
        expect.stringContaining(
          'install -d -o mysql -g mysql -m 0750 /var/lib/mysql',
        ),
        expect.stringContaining(
          'install -d -o mysql -g mysql -m 0750 /var/lib/mysql-files',
        ),
        expect.stringContaining('systemctl stop mysql'),
        expect.stringContaining(
          'find /var/lib/mysql -mindepth 1 -maxdepth 1 -print -quit',
        ),
        expect.stringContaining(
          'sudo mysqld --user=mysql --datadir=/var/lib/mysql --port=3307 --bind-address=0.0.0.0 --socket=/var/lib/mysql/mysql.sock --pid-file=/tmp/mysql8.pid --skip-grant-tables',
        ),
        expect.stringContaining(
          'sudo mysqladmin --protocol=socket --socket=/var/lib/mysql/mysql.sock ping -u root',
        ),
      ]),
    );
    expect(startCommand).toEqual(
      expect.objectContaining({
        detached: true,
        logfile: '/tmp/mysql8.log',
      }),
    );
    expect(restartCommand).toEqual(
      expect.objectContaining({
        detached: true,
        logfile: '/tmp/mysql8.log',
      }),
    );
    expect(runs.some((run) => run.includes('/etc/my.cnf.d'))).toBe(false);
  });

  it('starts redis7 with a managed pidfile and stale pid cleanup', async () => {
    const executor = createExecutorMock();

    await createRedisService('7').start(executor, 6380);

    const runs = executor.runs().map((command) => command.run);

    expect(runs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('systemctl stop redis-server'),
        expect.stringContaining('shutdown nosave'),
        expect.stringContaining('rm -f /data/services/redis/valkey.pid'),
        expect.stringContaining(
          'redis-server --daemonize yes --port 6380 --dir /data/services/redis --pidfile /data/services/redis/valkey.pid',
        ),
      ]),
    );
  });

  it('cleans stale clickhouse status files before startup', async () => {
    const executor = createExecutorMock();

    await createClickhouseService().start(executor, 9000);

    const runs = executor.runs().map((command) => command.run);

    expect(runs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'rm -f /var/lib/clickhouse/status /var/lib/clickhouse/status.tmp',
        ),
        expect.stringContaining(
          'nohup ./clickhouse server -C config.xml > server.log 2>&1 &',
        ),
      ]),
    );
  });

  it('verifies postgres liveness before removing stale socket files on resume', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check PostgreSQL data directory') {
        return {
          stdout: 'exists',
          stderr: '',
        };
      }

      if (command.name === 'Read PostgreSQL data directory version') {
        return {
          stdout: '17\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createPostgresService('17').start(executor, 5432);

    const cleanupRun = executor
      .runs()
      .find(
        (command) =>
          command.name === 'Clean up stale PostgreSQL PID and socket files',
      )?.run;
    const dataCheckRun = executor
      .runs()
      .find(
        (command) => command.name === 'Check PostgreSQL data directory',
      )?.run;
    const versionReadRun = executor
      .runs()
      .find(
        (command) => command.name === 'Read PostgreSQL data directory version',
      )?.run;

    expect(dataCheckRun).toContain(
      'sudo test -f "/data/services/postgres/data/PG_VERSION"',
    );
    expect(versionReadRun).toContain(
      'sudo cat /data/services/postgres/data/PG_VERSION',
    );
    expect(cleanupRun).toContain(
      'sudo -u postgres pg_ctl -D /data/services/postgres/data status',
    );
    expect(cleanupRun).toContain(
      'sudo test -f "/data/services/postgres/data/postmaster.pid"',
    );
    expect(cleanupRun).toContain('ps -p "$pid" -o stat=,comm=');
    expect(cleanupRun).toContain(
      'for socket_path in /var/run/postgresql/.s.PGSQL.5432 /tmp/.s.PGSQL.5432; do',
    );
    expect(cleanupRun).toContain('lock_path="$socket_path.lock"');
    expect(cleanupRun).toContain('is_live_postgres_pid "$lock_pid"');
  });

  it('cleans stale postgres socket files even when the data directory is rebuilt', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check PostgreSQL data directory') {
        return {
          stdout: 'missing',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await createPostgresService('17').start(executor, 5432);

    const commandNames = executor.runs().map((command) => command.name);
    expect(commandNames).toContain(
      'Clean up stale PostgreSQL PID and socket files',
    );
    expect(commandNames).toContain('Initialize PostgreSQL database');

    const cleanupIndex = commandNames.indexOf(
      'Clean up stale PostgreSQL PID and socket files',
    );
    const startIndex = commandNames.indexOf('Start PostgreSQL');

    expect(cleanupIndex).toBeGreaterThan(
      commandNames.indexOf('Initialize PostgreSQL database'),
    );
    expect(cleanupIndex).toBeLessThan(startIndex);
  });

  it('surfaces internal postgres log diagnostics when startup fails', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check PostgreSQL data directory') {
        return {
          stdout: 'exists',
          stderr: '',
        };
      }

      if (command.name === 'Read PostgreSQL data directory version') {
        return {
          stdout: '17\n',
          stderr: '',
        };
      }

      if (command.name === 'Start PostgreSQL') {
        throw new ExecutionError('Command failed with exit code 1', {
          command,
          success: false,
          duration: 12,
          exitCode: 1,
          stdout: 'waiting for server to start.... stopped waiting',
          stderr: 'pg_ctl: could not start server\nExamine the log output.',
          error: 'Command failed with exit code 1',
        });
      }

      if (command.name === 'Read PostgreSQL startup diagnostics') {
        return {
          stdout:
            '--- /data/services/postgres/data/log/postgresql-Thu.log ---\nFATAL:  lock file "/tmp/.s.PGSQL.5432.lock" already exists',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await expect(
      createPostgresService('17').start(executor, 5432),
    ).rejects.toThrowError(
      /lock file "\/tmp\/\.s\.PGSQL\.5432\.lock" already exists/,
    );

    expect(
      executor
        .runs()
        .some(
          (command) => command.name === 'Read PostgreSQL startup diagnostics',
        ),
    ).toBe(true);
  });

  it('fails fast when a restored postgres data directory version does not match the requested service version', async () => {
    const executor = createExecutorMock();

    executor.execute.mockImplementation(async (command: ExecuteCall) => {
      if (command.name === 'Check PostgreSQL data directory') {
        return {
          stdout: 'exists',
          stderr: '',
        };
      }

      if (command.name === 'Read PostgreSQL data directory version') {
        return {
          stdout: '16\n',
          stderr: '',
        };
      }

      return {
        stdout: '',
        stderr: '',
      };
    });

    await expect(
      createPostgresService('17').start(executor, 5432),
    ).rejects.toThrowError(/expected 17, found 16/);

    expect(
      executor.runs().some((command) => command.name === 'Start PostgreSQL'),
    ).toBe(false);
  });
});

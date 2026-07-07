import { execa } from 'execa';

import { ExecutionError } from '../command-executor';
import { withAptLock } from '../commands/setup/package-manager';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

/**
 * Creates a PostgreSQL service definition for the specified major version.
 *
 * Ubuntu-based workers prefer the PGDG packages baked into newer worker
 * images, with binaries available under `/usr/lib/postgresql/<ver>/bin/`.
 * Older images still fall back to the runtime apt install path.
 */
export function createPostgresService(majorVersion: string): ServiceDefinition {
  const serviceName = `postgres${majorVersion}` as keyof typeof SERVICE_CONFIG;

  const config = SERVICE_CONFIG[serviceName] as {
    defaultPort: number;
    version: string;
    dataDir: string;
    logFile: string;
  };

  const socketDirs = ['/var/run/postgresql', '/tmp'];
  const healthCheck = async (port: number) => {
    try {
      await execa('pg_isready', ['-h', 'localhost', '-p', String(port)], {
        timeout: 5000,
      });

      return true;
    } catch {
      return false;
    }
  };

  return {
    defaultPort: config.defaultPort,

    async install(executor) {
      const prebakedBinaryDir = `/usr/lib/postgresql/${majorVersion}/bin`;

      const prebakedBinaryCheck = await executor.execute({
        name: `Check prebaked PostgreSQL ${majorVersion} binaries`,
        run: `test -x "${prebakedBinaryDir}/psql" && test -x "${prebakedBinaryDir}/initdb" && test -x "${prebakedBinaryDir}/pg_ctl" && echo "prebaked" || echo "missing"`,
        timeout: 30,
        continue_on_error: true,
      });

      if (prebakedBinaryCheck.stdout?.includes('prebaked')) {
        await executor.execute({
          name: `Ensure PostgreSQL ${majorVersion} prerequisites`,
          run: `id -u postgres &>/dev/null || sudo useradd -r -s /sbin/nologin postgres && sudo mkdir -p /data/services/postgres && sudo chown postgres:postgres /data/services/postgres && sudo chmod 755 /data/services/postgres`,
          timeout: 60,
          continue_on_error: false,
        });

        await executor.execute({
          name: 'Symlink PostgreSQL binaries to /usr/local/bin',
          run: `for bin in psql initdb pg_ctl pg_isready pg_dump pg_restore; do sudo ln -sf ${prebakedBinaryDir}/$bin /usr/local/bin/$bin; done`,
          timeout: 30,
          continue_on_error: false,
        });

        await executor.execute({
          name: 'Stop auto-started PostgreSQL cluster',
          run: `sudo pg_ctlcluster ${majorVersion} main stop 2>/dev/null || true`,
          timeout: 30,
          continue_on_error: true,
        });

        return;
      }

      // Detect currently installed PostgreSQL version to avoid unnecessary
      // package operations when the default installation already matches.
      // Check both psql (client) and initdb (server) to ensure full installation.
      const versionResult = await executor.execute({
        name: 'Check installed PostgreSQL version',
        run: `psql --version 2>/dev/null || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      // Check if server tools are installed (initdb comes from postgresql-server).
      const serverResult = await executor.execute({
        name: 'Check PostgreSQL server tools',
        run: `command -v initdb >/dev/null 2>&1 && command -v initdb || echo "not_installed"`,
        timeout: 30,
        continue_on_error: true,
      });

      // Parse major version from output like "psql (PostgreSQL) 16.1"
      const versionMatch = versionResult.stdout?.match(/PostgreSQL\)\s+(\d+)/);
      const installedMajorVersion = versionMatch?.[1];
      const serverInstalled = !serverResult.stdout?.includes('not_installed');

      if (installedMajorVersion === majorVersion && serverInstalled) {
        // Correct version already installed with server tools - just ensure prerequisites exist.
        console.log(
          `PostgreSQL ${majorVersion} server already installed, skipping package operations`,
        );

        await executor.execute({
          name: `Ensure PostgreSQL ${majorVersion} prerequisites`,
          run: `id -u postgres &>/dev/null || sudo useradd -r -s /sbin/nologin postgres && sudo mkdir -p /data/services/postgres && sudo chown postgres:postgres /data/services/postgres && sudo chmod 755 /data/services/postgres`,
          timeout: 60,
          continue_on_error: false,
        });

        return;
      }

      await withAptLock(() =>
        executor.execute({
          name: 'Add PostgreSQL APT repository',
          run: `sudo apt-get update && sudo apt-get install -y gnupg2 lsb-release && sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list' && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --batch --yes --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && sudo apt-get update -o Dir::Etc::sourcelist='sources.list.d/pgdg.list' -o Dir::Etc::sourceparts='-' -o APT::Get::List-Cleanup='0'`,
          // PGDG mirror refreshes can legitimately exceed two minutes on slow
          // sandboxes, and timing out here causes a full bootstrap failure.
          timeout: 240,
          continue_on_error: false,
        }),
      );

      await withAptLock(() =>
        executor.execute({
          name: `Install PostgreSQL ${majorVersion}`,
          run: `sudo apt-get install -y postgresql-${majorVersion} && (id -u postgres &>/dev/null || sudo useradd -r -s /sbin/nologin postgres) && sudo mkdir -p /data/services/postgres && sudo chown postgres:postgres /data/services/postgres && sudo chmod 755 /data/services/postgres`,
          timeout: 300,
          continue_on_error: false,
        }),
      );

      // Debian/Ubuntu installs PG with an auto-created cluster; stop it so we
      // manage our own instance.
      await executor.execute({
        name: 'Stop auto-started PostgreSQL cluster',
        run: `sudo pg_ctlcluster ${majorVersion} main stop 2>/dev/null || true`,
        timeout: 30,
        continue_on_error: true,
      });

      // Ensure PG binaries are on PATH (Debian/Ubuntu puts them in
      // /usr/lib/postgresql/<ver>/bin/).
      await executor.execute({
        name: 'Symlink PostgreSQL binaries to /usr/local/bin',
        run: `for bin in psql initdb pg_ctl pg_isready pg_dump pg_restore; do sudo ln -sf /usr/lib/postgresql/${majorVersion}/bin/$bin /usr/local/bin/$bin; done`,
        timeout: 30,
        continue_on_error: false,
      });
    },

    async start(executor, port) {
      const socketPaths = socketDirs.map((dir) => `${dir}/.s.PGSQL.${port}`);
      const cleanupStaleRuntimeFilesCommand = `is_live_postgres_pid() { \
  pid="$1"; \
  if [ -z "$pid" ]; then return 1; fi; \
  ps -p "$pid" -o stat=,comm= 2>/dev/null | awk 'NF >= 2 && $1 !~ /^Z/ && $2 == "postgres" { found = 1 } END { exit found ? 0 : 1 }'; \
}; \
server_running=0; \
postmaster_pid=""; \
if sudo test -f "${config.dataDir}/postmaster.pid"; then \
  postmaster_pid=$(sudo head -n 1 "${config.dataDir}/postmaster.pid" 2>/dev/null | tr -dc '0-9'); \
fi; \
if sudo -u postgres pg_ctl -D ${config.dataDir} status >/dev/null 2>&1 && is_live_postgres_pid "$postmaster_pid"; then \
  server_running=1; \
fi; \
if [ "$server_running" != "1" ] && sudo test -f "${config.dataDir}/postmaster.pid"; then \
  sudo rm -f "${config.dataDir}/postmaster.pid"; \
fi; \
for socket_path in ${socketPaths.join(' ')}; do \
  lock_path="$socket_path.lock"; \
  if [ ! -e "$socket_path" ] && [ ! -e "$lock_path" ]; then continue; fi; \
  lock_pid=""; \
  if [ -f "$lock_path" ]; then lock_pid=$(sudo head -n 1 "$lock_path" 2>/dev/null | tr -dc '0-9'); fi; \
  if [ "$server_running" = "1" ]; then \
    if is_live_postgres_pid "$lock_pid"; then continue; fi; \
    if [ -z "$lock_pid" ] && is_live_postgres_pid "$postmaster_pid"; then continue; fi; \
  fi; \
  if is_live_postgres_pid "$lock_pid"; then continue; fi; \
  sudo rm -f "$lock_path" "$socket_path"; \
done`;

      // Create Unix socket directory (required for PostgreSQL to start).
      // Explicitly set 755 permissions so non-postgres users can connect via psql.
      await executor.execute({
        name: 'Create PostgreSQL socket directory',
        run: `sudo mkdir -p /var/run/postgresql && sudo chown postgres:postgres /var/run/postgresql && sudo chmod 755 /var/run/postgresql`,
        timeout: 30,
        continue_on_error: false,
      });

      // Check if a valid data directory already exists (e.g., from a snapshot).
      // PG_VERSION is created last during initdb, so its presence indicates
      // a complete initialization. This preserves existing data (migrations,
      // seeds) when resuming from a snapshot.
      const dataCheckResult = await executor.execute({
        name: 'Check PostgreSQL data directory',
        run: `sudo test -f "${config.dataDir}/PG_VERSION" && echo "exists" || echo "missing"`,
        timeout: 30,
        continue_on_error: true,
      });

      const dataExists = dataCheckResult.stdout?.includes('exists');

      if (dataExists) {
        await executor.execute({
          name: 'Ensure PostgreSQL data directory ownership',
          run: `sudo chown -R postgres:postgres ${config.dataDir} && sudo chmod 700 ${config.dataDir} && sudo touch ${config.logFile} && sudo chown postgres:postgres ${config.logFile}`,
          timeout: 30,
          continue_on_error: false,
        });

        const versionResult = await executor.execute({
          name: 'Read PostgreSQL data directory version',
          run: `sudo cat ${config.dataDir}/PG_VERSION`,
          timeout: 30,
          continue_on_error: false,
        });

        const dataDirVersion = versionResult.stdout?.trim();

        if (dataDirVersion !== majorVersion) {
          throw new Error(
            `PostgreSQL data directory version mismatch: expected ${majorVersion}, found ${dataDirVersion ?? 'unknown'} in ${config.dataDir}`,
          );
        }
      } else {
        // Delete any partial/corrupted data directory.
        await executor.execute({
          name: 'Delete existing PostgreSQL data directory',
          run: `sudo rm -rf ${config.dataDir}`,
          timeout: 30,
          continue_on_error: false,
        });

        // Create fresh data directory with correct ownership.
        // PostgreSQL requires 700 permissions on data directory for security.
        await executor.execute({
          name: 'Create fresh PostgreSQL data directory',
          run: `sudo mkdir -p ${config.dataDir} && sudo chown -R postgres:postgres ${config.dataDir} && sudo chmod 700 ${config.dataDir} && sudo touch ${config.logFile} && sudo chown postgres:postgres ${config.logFile}`,
          timeout: 30,
          continue_on_error: false,
        });

        // Initialize database.
        await executor.execute({
          name: 'Initialize PostgreSQL database',
          run: `sudo -u postgres initdb -D ${config.dataDir} --auth=trust`,
          timeout: 120,
          continue_on_error: false,
        });
      }

      // Remove stale PID and socket files that may remain after snapshot
      // restore or abrupt termination. Resume runs in a fresh sandbox, so a
      // leftover PID or socket artifact is not enough to prove a live
      // postmaster still exists. Verify liveness before keeping any runtime
      // file around.
      await executor.execute({
        name: 'Clean up stale PostgreSQL PID and socket files',
        run: cleanupStaleRuntimeFilesCommand,
        timeout: 30,
        continue_on_error: true,
      });

      // Start PostgreSQL with custom port (run as postgres user).
      // This always runs - processes don't survive snapshot restore.
      try {
        await executor.execute({
          name: 'Start PostgreSQL',
          run: `sudo -u postgres pg_ctl -D ${config.dataDir} -o "-p ${port}" -l ${config.logFile} start`,
          timeout: 60,
          continue_on_error: false,
        });
      } catch (error) {
        const diagnostics = await executor.execute({
          name: 'Read PostgreSQL startup diagnostics',
          run: `echo "--- ${config.logFile} ---"; sudo tail -n 50 ${config.logFile} 2>/dev/null || true; latest_log=$(sudo ls -1t ${config.dataDir}/log 2>/dev/null | head -n 1); if [ -n "$latest_log" ]; then echo ""; echo "--- ${config.dataDir}/log/$latest_log ---"; sudo tail -n 200 "${config.dataDir}/log/$latest_log"; else echo ""; echo "No PostgreSQL internal log files found under ${config.dataDir}/log"; fi`,
          timeout: 30,
          continue_on_error: true,
        });

        const parts = ['Failed to start PostgreSQL'];

        if (error instanceof ExecutionError) {
          parts.push(`\n${error.formatDetails()}`);
        } else {
          parts.push(
            `\n${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (diagnostics.stdout) {
          parts.push(
            `\nstartup diagnostics -> ${diagnostics.stdout.trimEnd()}`,
          );
        }

        if (diagnostics.stderr) {
          parts.push(`\ndiagnostics stderr -> ${diagnostics.stderr.trimEnd()}`);
        }

        throw new Error(parts.join(''));
      }

      // Wait for PostgreSQL to be ready.
      await executor.execute({
        name: 'Wait for PostgreSQL to be ready',
        run: `for i in {1..30}; do pg_isready -h localhost -p ${port} && break || sleep 1; done`,
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

        const postmasterPid = (
          await execa(
            'sudo',
            ['head', '-n', '1', `${config.dataDir}/postmaster.pid`],
            {
              timeout: 5000,
            },
          )
        ).stdout.trim();

        if (!/^\d+$/.test(postmasterPid)) {
          return false;
        }

        const pgCtlStatus = await execa(
          'sudo',
          ['-u', 'postgres', 'pg_ctl', '-D', config.dataDir, 'status'],
          {
            timeout: 5000,
          },
        );

        if (!pgCtlStatus.stdout.includes(`PID: ${postmasterPid}`)) {
          return false;
        }

        const processDetails = await execa(
          'ps',
          ['-p', postmasterPid, '-o', 'stat=', '-o', 'args='],
          {
            timeout: 5000,
          },
        );

        const [stat = '', ...argsParts] = processDetails.stdout
          .trim()
          .split(/\s+/);
        const args = argsParts.join(' ');

        return !stat.startsWith('Z') && args.includes(config.dataDir);
      } catch {
        return false;
      }
    },

    getConnectionInfo(port) {
      const user = 'postgres';

      return {
        connectionString: `postgresql://${user}@localhost:${port}/postgres`,
        envVars: {
          DATABASE_URL: `postgresql://${user}@localhost:${port}/postgres`,
          POSTGRES_HOST: 'localhost',
          POSTGRES_PORT: String(port),
          POSTGRES_USER: user,
          POSTGRES_DB: 'postgres',
        },
      };
    },
  };
}

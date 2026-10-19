import { access, chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { ServiceManager } from '../service-manager';

// Opt-in disposable-worker test: startup uses the real managed paths and stops
// distro MySQL services. Never run against a worker containing existing data.
it('preserves a separate MySQL server while bootstrapping the managed service', async () => {
  const managedPaths = [
    '/var/lib/mysql',
    '/var/lib/mysql-files',
    '/tmp/mysql8.pid',
    '/tmp/mysql8.log',
  ];
  for (const path of managedPaths) {
    await expect(
      access(path),
      `requires unused managed path ${path}`,
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }

  const root = await mkdtemp(join(tmpdir(), 'roomote-mysql-restart-'));
  const dataDir = join(root, 'data');
  const socket = join(root, 'sibling.sock');
  const pidfile = join(root, 'sibling.pid');
  const mysql = (socketPath: string, query: string) =>
    execa('sudo', [
      'mysql',
      '--protocol=socket',
      `--socket=${socketPath}`,
      '-u',
      'root',
      '-Nse',
      query,
    ]);
  const shutdown = async (socketPath: string, pidPath: string) => {
    const pid = await readFile(pidPath, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      },
    );
    await execa(
      'sudo',
      [
        'mysqladmin',
        '--protocol=socket',
        `--socket=${socketPath}`,
        '-u',
        'root',
        'shutdown',
      ],
      { reject: false, timeout: 30_000 },
    );
    if (pid.trim()) {
      expect(pid.trim()).toMatch(/^\d+$/);
      const alive = await execa('sudo', ['kill', '-0', pid.trim()], {
        reject: false,
      });
      // Keep the fixture files for inspection rather than deleting live data.
      expect(alive.exitCode).not.toBe(0);
    }
  };

  try {
    await execa('sudo', [
      'bash',
      '-c',
      'getent group mysql >/dev/null || groupadd --system mysql; id -u mysql >/dev/null 2>&1 || useradd --system --gid mysql --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin mysql',
    ]);
    await chmod(root, 0o755);
    await execa('sudo', [
      'install',
      '-d',
      '-o',
      'mysql',
      '-g',
      'mysql',
      dataDir,
    ]);
    await execa('sudo', ['chown', 'mysql:mysql', root]);
    await execa('sudo', [
      'mysqld',
      '--no-defaults',
      '--initialize-insecure',
      '--user=mysql',
      `--datadir=${dataDir}`,
    ]);
    await execa(
      'sudo',
      [
        'mysqld',
        '--no-defaults',
        '--user=mysql',
        `--datadir=${dataDir}`,
        `--secure-file-priv=${root}`,
        `--socket=${socket}`,
        `--pid-file=${pidfile}`,
        `--log-error=${root}/sibling.log`,
        '--skip-networking',
        '--mysqlx=0',
        '--daemonize',
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
    const siblingPid = (await readFile(pidfile, 'utf8')).trim();
    await mysql(
      socket,
      'CREATE DATABASE preserved; CREATE TABLE preserved.marker (value INT); INSERT INTO preserved.marker VALUES (42)',
    );

    const manager = new ServiceManager(
      root,
      { PATH: process.env.PATH, HOME: root },
      join(root, 'services'),
    );
    const [info] = await manager.startServices(
      { userLog: console, debug: console, setFilePath: () => {} },
      [{ name: 'mysql8', port: 13316 }],
    );
    expect(info?.envVars.MYSQL_PORT).toBe('13316');
    expect(
      (await mysql('/var/lib/mysql/mysql.sock', 'SELECT @@port')).stdout,
    ).toBe('13316');
    expect(
      (await mysql(socket, 'SELECT value FROM preserved.marker')).stdout,
    ).toBe('42');
    expect((await readFile(pidfile, 'utf8')).trim()).toBe(siblingPid);
    // The configured TCP connection must also work after leaving bootstrap mode.
    expect(
      (
        await execa('mysql', [
          '--protocol=tcp',
          '-h',
          '127.0.0.1',
          '-P',
          '13316',
          '-u',
          'root',
          '-Nse',
          'SELECT 1',
        ])
      ).stdout,
    ).toBe('1');
  } finally {
    await shutdown('/var/lib/mysql/mysql.sock', '/tmp/mysql8.pid');
    await shutdown(socket, pidfile);
    await execa('sudo', ['rm', '-rf', ...managedPaths, root]);
  }
}, 180_000);

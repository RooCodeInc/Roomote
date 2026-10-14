import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

import { createStartupLogger } from '../../logging';
import { ServiceManager } from '../service-manager';
import { createPostgresService } from '../postgres';
import { findFreePort } from '../find-free-port';

const { fixturePaths } = vi.hoisted(() => ({
  fixturePaths: { dataDir: '', logFile: '' },
}));
vi.mock('../constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('../constants')>();
  return {
    ...original,
    SERVICE_CONFIG: {
      ...original.SERVICE_CONFIG,
      postgres16: {
        ...original.SERVICE_CONFIG.postgres16,
        get dataDir() {
          return fixturePaths.dataDir;
        },
        get logFile() {
          return fixturePaths.logFile;
        },
      },
    },
  };
});
vi.mock('../service-definition', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../service-definition')>();
  return {
    ...original,
    getServiceDefinition: (
      ...args: Parameters<typeof original.getServiceDefinition>
    ) => ({
      ...original.getServiceDefinition(...args),
      // Native tools are already installed. Do not change shared binaries,
      // apt packages or distro clusters in this disposable ownership test.
      install: async () => {},
    }),
  };
});

describe('PostgreSQL managed port ownership (native clusters)', () => {
  let root: string;
  const clusterDirs: string[] = [];
  let managedPort: number;
  let unrelatedPort: number;
  let unrelatedDir: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'roomote-pg-ownership-'));
    await execa('chmod', ['755', root]);
    await execa('sudo', ['chown', 'postgres:postgres', root]);
    fixturePaths.dataDir = path.join(root, 'managed');
    fixturePaths.logFile = path.join(root, 'managed.log');
    unrelatedDir = path.join(root, 'unrelated');
    managedPort = await findFreePort();
    unrelatedPort = await findFreePort();
    while (unrelatedPort === managedPort) unrelatedPort = await findFreePort();
    for (const [dataDir, port] of [
      [fixturePaths.dataDir, managedPort],
      [unrelatedDir, unrelatedPort],
    ] as const) {
      await execa('sudo', [
        'install',
        '-d',
        '-o',
        'postgres',
        '-g',
        'postgres',
        '-m',
        '700',
        dataDir,
      ]);
      await execa('sudo', [
        '-u',
        'postgres',
        'initdb',
        '-D',
        dataDir,
        '--auth=trust',
      ]);
      const logFile = `${dataDir}.log`;
      await execa('sudo', ['touch', logFile]);
      await execa('sudo', ['chown', 'postgres:postgres', logFile]);
      clusterDirs.push(dataDir);
      await execa('sudo', [
        '-u',
        'postgres',
        'pg_ctl',
        '-D',
        dataDir,
        '-o',
        `-p ${port} -k ${root}`,
        '-l',
        logFile,
        '-w',
        'start',
      ]);
      await execa('psql', [
        '-h',
        'localhost',
        '-p',
        String(port),
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-c',
        'CREATE TABLE ownership_marker (value text)',
      ]);
      await execa('psql', [
        '-h',
        'localhost',
        '-p',
        String(port),
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-c',
        `INSERT INTO ownership_marker VALUES ('${dataDir === fixturePaths.dataDir ? 'managed' : 'unrelated'}')`,
      ]);
    }
  }, 30_000);

  afterAll(async () => {
    for (const dataDir of clusterDirs) {
      await execa(
        'sudo',
        [
          '-u',
          'postgres',
          'pg_ctl',
          '-D',
          dataDir,
          '-m',
          'immediate',
          '-w',
          'stop',
        ],
        { reject: false },
      );
    }
    if (root) {
      await execa('sudo', [
        'chown',
        '-R',
        `${process.getuid!()}:${process.getgid!()}`,
        root,
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unrelated healthy port rather than returning its connection', async () => {
    const definition = createPostgresService('16');
    expect(await definition.verifyManagedInstance!(managedPort)).toBe(true);
    const unrelatedVerified =
      await definition.verifyManagedInstance!(unrelatedPort);
    const manager = new ServiceManager(
      root,
      { PATH: process.env.PATH, HOME: process.env.HOME },
      path.join(root, 'services'),
    );
    const outcome = await manager
      .startServices(createStartupLogger(), [
        { name: 'postgres16', port: unrelatedPort },
      ])
      .then(
        (services) => ({ refused: false, services }),
        () => ({ refused: true, services: [] }),
      );
    const marker = await execa('psql', [
      '-h',
      'localhost',
      '-p',
      String(unrelatedPort),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      'SELECT value FROM ownership_marker',
    ]);
    expect(marker.stdout).toBe('unrelated');
    expect(outcome).toEqual({ refused: true, services: [] });
    expect(unrelatedVerified).toBe(false);
  }, 30_000);

  it('recovers an already-running managed port and preserves its database', async () => {
    const manager = new ServiceManager(
      root,
      { PATH: process.env.PATH, HOME: process.env.HOME },
      path.join(root, 'services'),
    );
    const [service] = await manager.startServices(createStartupLogger(), [
      { name: 'postgres16', port: managedPort },
    ]);
    expect(service?.port).toBe(managedPort);
    const marker = await execa('psql', [
      '-h',
      'localhost',
      '-p',
      String(service!.port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      'SELECT value FROM ownership_marker',
    ]);
    expect(marker.stdout).toBe('managed');
  }, 30_000);

  it('starts the preserved managed database after removing the port conflict', async () => {
    for (const dataDir of clusterDirs) {
      await execa('sudo', [
        '-u',
        'postgres',
        'pg_ctl',
        '-D',
        dataDir,
        '-m',
        'fast',
        '-w',
        'stop',
      ]);
    }
    const manager = new ServiceManager(
      root,
      { PATH: process.env.PATH, HOME: process.env.HOME },
      path.join(root, 'services'),
    );
    const [service] = await manager.startServices(createStartupLogger(), [
      { name: 'postgres16', port: unrelatedPort },
    ]);
    expect(service?.port).toBe(unrelatedPort);
    const marker = await execa('psql', [
      '-h',
      'localhost',
      '-p',
      String(service!.port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      'SELECT value FROM ownership_marker',
    ]);
    expect(marker.stdout).toBe('managed');
    expect(
      await createPostgresService('16').verifyManagedInstance!(unrelatedPort),
    ).toBe(true);
  }, 30_000);
});

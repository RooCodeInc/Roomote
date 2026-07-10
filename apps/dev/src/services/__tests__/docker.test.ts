import path from 'node:path';

import Docker from 'dockerode';
import { execa } from 'execa';

import { DockerService } from '../docker';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('dockerode', () => ({
  default: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    info: vi.fn(),
    start: () => ({
      succeed: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    }),
  })),
}));

describe('DockerService.checkContainers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('does nothing when base infra containers are already running', async () => {
    const listContainers = vi
      .fn()
      .mockResolvedValueOnce([
        { Names: ['/roomote-postgres'] },
        { Names: ['/roomote-redis'] },
        { Names: ['/roomote-minio'] },
        { Names: ['/roomote-caddy-dev'] },
      ])
      .mockResolvedValueOnce([
        { Names: ['/roomote-postgres'] },
        { Names: ['/roomote-redis'] },
        { Names: ['/roomote-minio'] },
        { Names: ['/roomote-caddy-dev'] },
      ]);

    vi.mocked(Docker).mockImplementation(function MockDocker() {
      return {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers,
      } as unknown as Docker;
    } as unknown as typeof Docker);

    await DockerService.checkContainers(false);

    expect(execa).not.toHaveBeenCalled();
  });

  it('starts full infra when redis is missing', async () => {
    vi.useFakeTimers();
    const expectedCwd = path.resolve(process.cwd(), '../..');
    const originalProcessEnv = { ...process.env };

    process.env.DATABASE_URL =
      'postgres://postgres:password@localhost:15432/roomote_development';
    process.env.DATABASE_URL_TEST =
      'postgres://postgres:password@localhost:15432/custom_test';
    process.env.REDIS_URL = 'redis://localhost:16379';
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '15432';
    process.env.PGDATABASE = 'roomote_development';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';

    const listContainers = vi
      .fn()
      .mockResolvedValueOnce([{ Names: ['/roomote-postgres'] }])
      .mockResolvedValueOnce([{ Names: ['/roomote-postgres'] }])
      .mockResolvedValueOnce([
        { Names: ['/roomote-postgres'] },
        { Names: ['/roomote-redis'] },
        { Names: ['/roomote-minio'] },
        { Names: ['/roomote-caddy-dev'] },
      ]);

    vi.mocked(Docker).mockImplementation(function MockDocker() {
      return {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers,
      } as unknown as Docker;
    } as unknown as typeof Docker);

    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    try {
      const checkPromise = DockerService.checkContainers(false);

      await vi.runAllTimersAsync();
      await checkPromise;
    } finally {
      process.env = originalProcessEnv;
    }

    const execaCalls = vi.mocked(execa).mock.calls as unknown as Array<
      [
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv; [key: string]: unknown },
      ]
    >;
    const infraUpCall = execaCalls.find(
      ([command, args]) => command === 'pnpm' && args[0] === 'infra:up',
    );

    expect(infraUpCall?.[2]).toMatchObject({
      stdio: 'inherit',
      cwd: expectedCwd,
      extendEnv: false,
    });
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('DATABASE_URL');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('DATABASE_URL_TEST');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('REDIS_URL');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('PGDATABASE');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('PGHOST');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('PGPASSWORD');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('PGPORT');
    expect(infraUpCall?.[2]?.env).not.toHaveProperty('PGUSER');
    expect(listContainers).toHaveBeenCalledTimes(3);
  });

  it('removes same-checkout legacy infra containers without touching current or sibling containers', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    const listContainers = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Names: ['/roomote-legacy-postgres'],
          Labels: {
            'com.docker.compose.project': 'roomote-legacy',
            'com.docker.compose.project.working_dir': rootDir,
            'com.docker.compose.service': 'postgres',
          },
        },
        {
          Names: ['/roomote-redis'],
          Ports: [{ PublicPort: 16379 }],
          Labels: {
            'com.docker.compose.project': 'roomote',
            'com.docker.compose.project.working_dir': rootDir,
            'com.docker.compose.service': 'redis',
          },
        },
        {
          Names: ['/roomote-legacy-minio'],
          Labels: {
            'com.docker.compose.project': 'roomote-legacy',
            'com.docker.compose.project.working_dir': rootDir,
            'com.docker.compose.service': 'minio',
          },
        },
        {
          Names: ['/sibling-roomote-postgres'],
          Labels: {
            'com.docker.compose.project': 'roomote',
            'com.docker.compose.project.working_dir':
              '/Users/matt/Code/roomote/Roomote',
            'com.docker.compose.service': 'postgres',
          },
        },
      ])
      .mockResolvedValueOnce([
        { Names: ['/roomote-postgres'] },
        { Names: ['/roomote-redis'] },
        { Names: ['/roomote-minio'] },
        { Names: ['/roomote-caddy-dev'] },
      ]);

    vi.mocked(Docker).mockImplementation(function MockDocker() {
      return {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers,
      } as unknown as Docker;
    } as unknown as typeof Docker);

    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await DockerService.checkContainers(false);

    expect(execa).toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-legacy-postgres',
    ]);
    expect(execa).not.toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-redis',
    ]);
    expect(execa).toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-legacy-minio',
    ]);
    expect(execa).not.toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'sibling-roomote-postgres',
    ]);
  });

  it('removes current infra containers when they are missing local published ports', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    const listContainers = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Names: ['/roomote-postgres'],
          Ports: [],
          Labels: {
            'com.docker.compose.project': 'roomote',
            'com.docker.compose.project.working_dir': rootDir,
            'com.docker.compose.service': 'postgres',
          },
        },
      ])
      .mockResolvedValueOnce([
        { Names: ['/roomote-postgres'] },
        { Names: ['/roomote-redis'] },
        { Names: ['/roomote-minio'] },
        { Names: ['/roomote-caddy-dev'] },
      ]);

    vi.mocked(Docker).mockImplementation(function MockDocker() {
      return {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers,
      } as unknown as Docker;
    } as unknown as typeof Docker);

    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await DockerService.checkContainers(false);

    expect(execa).toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-postgres',
    ]);
    expect(execa).not.toHaveBeenCalledWith(
      'pnpm',
      ['infra:up'],
      expect.anything(),
    );
  });
});

describe('DockerService.stopSelfHostAppContainers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes same-checkout self-host app containers without touching database containers or sibling checkouts', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    const listContainers = vi.fn().mockResolvedValue([
      {
        Names: ['/roomote-web'],
        Labels: {
          'com.docker.compose.project': 'roomote',
          'com.docker.compose.project.working_dir': rootDir,
          'com.docker.compose.service': 'web',
        },
      },
      {
        Names: ['/roomote-legacy-controller'],
        Labels: {
          'com.docker.compose.project': 'roomote-legacy',
          'com.docker.compose.project.working_dir': rootDir,
          'com.docker.compose.service': 'controller',
        },
      },
      {
        Names: ['/roomote-postgres'],
        Labels: {
          'com.docker.compose.project': 'roomote',
          'com.docker.compose.project.working_dir': rootDir,
          'com.docker.compose.service': 'postgres',
        },
      },
      {
        Names: ['/sibling-roomote-web'],
        Labels: {
          'com.docker.compose.project': 'roomote',
          'com.docker.compose.project.working_dir':
            '/Users/matt/Code/roomote/OtherRoomote',
          'com.docker.compose.service': 'web',
        },
      },
    ]);

    vi.mocked(Docker).mockImplementation(function MockDocker() {
      return {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers,
      } as unknown as Docker;
    } as unknown as typeof Docker);

    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await DockerService.stopSelfHostAppContainers(false);

    expect(execa).toHaveBeenCalledWith('docker', ['rm', '-f', 'roomote-web']);
    expect(execa).toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-legacy-controller',
    ]);
    expect(execa).not.toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'roomote-postgres',
    ]);
    expect(execa).not.toHaveBeenCalledWith('docker', [
      'rm',
      '-f',
      'sibling-roomote-web',
    ]);
  });
});

describe('DockerService.ensureWorkerImage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds the local worker image for the default Docker platform when missing', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('missing image'))
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>);

    await DockerService.ensureWorkerImage(false);

    expect(execa).toHaveBeenCalledWith('docker', [
      'image',
      'inspect',
      'roomote-worker:local',
    ]);
    expect(execa).toHaveBeenCalledWith(
      'docker',
      [
        'build',
        '--platform',
        process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
        '-f',
        'apps/worker/Dockerfile',
        '-t',
        'roomote-worker:local',
        '.',
      ],
      { cwd: rootDir },
    );
  });

  it('honors custom Docker worker image and platform settings', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');
    process.env.DOCKER_WORKER_IMAGE = 'custom-worker:test';
    process.env.DOCKER_WORKER_PLATFORM = 'linux/arm64';

    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('missing image'))
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>);

    await DockerService.ensureWorkerImage(true);

    expect(execa).toHaveBeenCalledWith('docker', [
      'image',
      'inspect',
      'custom-worker:test',
    ]);
    expect(execa).toHaveBeenCalledWith(
      'docker',
      [
        'build',
        '--platform',
        'linux/arm64',
        '-f',
        'apps/worker/Dockerfile',
        '-t',
        'custom-worker:test',
        '.',
      ],
      { cwd: rootDir, stdio: 'inherit' },
    );
  });
});

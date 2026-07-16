import path from 'path';

import { execa } from 'execa';

import { PM2Service } from '../pm2';
import type { ScriptOptions } from '../../types';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: () => ({
      succeed: vi.fn(),
      warn: vi.fn(),
      fail: vi.fn(),
    }),
  })),
}));

describe('PM2Service.startServices', () => {
  const baseOptions: ScriptOptions = {
    reset: false,
    verbose: false,
    autoNgrok: false,
    publicUrl: 'https://roomote-example.ngrok.app',
    skipWorkerReleaseBuild: false,
    useRelease: false,
    workerReleaseChannel: 'stable',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);
  });

  it('runs dev prepare hooks before launching pm2 services', async () => {
    await PM2Service.prepareServicesForDev();

    const expectedRootDir = path.resolve(process.cwd(), '../..');

    expect(execa).toHaveBeenCalledWith(
      'pnpm',
      ['-r', '--if-present', 'run', 'dev:prepare'],
      { cwd: expectedRootDir },
    );
  });

  function getPm2Env(): NodeJS.ProcessEnv {
    const pm2Call = vi.mocked(execa).mock.calls[1] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];

    return pm2Call[2].env;
  }

  it('omits optional worker release env vars when release mode is disabled', async () => {
    await PM2Service.startServices(baseOptions);

    const pm2Env = getPm2Env();

    expect(pm2Env).toMatchObject({
      R_PUBLIC_URL: 'https://roomote-example.ngrok.app',
      R_APP_URL: 'https://roomote-example.ngrok.app',
      USE_WORKER_RELEASE: 'false',
    });
    expect(pm2Env).not.toHaveProperty('WORKER_RELEASE_CHANNEL');
    expect(pm2Env).not.toHaveProperty('WORKER_RELEASE_VERSION');
  });

  it('omits the pinned version env var when using the release channel without a pinned version', async () => {
    await PM2Service.startServices({
      ...baseOptions,
      useRelease: true,
    });

    const pm2Env = getPm2Env();

    expect(pm2Env).toMatchObject({
      USE_WORKER_RELEASE: 'true',
      WORKER_RELEASE_CHANNEL: 'stable',
    });
    expect(pm2Env).not.toHaveProperty('WORKER_RELEASE_VERSION');
  });
});

describe('PM2Service.stopServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes Roomote-owned PM2 processes by id', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          name: 'roomote-api',
          pm_id: 1,
          pm2_env: { pm_cwd: '/tmp/other' },
        },
        {
          name: 'api',
          pm_id: 2,
          pm2_env: { pm_cwd: rootDir },
        },
        {
          name: 'api',
          pm_id: 3,
          pm2_env: { pm_cwd: '/tmp/roomote' },
        },
        {
          name: 'roomote-preview-proxy-ngrok',
          pm_id: 4,
          pm2_env: { pm_cwd: rootDir },
        },
        {
          name: 'roomote-discord-gateway',
          pm_id: 5,
          pm2_env: { pm_cwd: rootDir },
        },
      ]),
    } as Awaited<ReturnType<typeof execa>>);
    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await PM2Service.stopServices();

    expect(execa).toHaveBeenCalledTimes(5);
    expect(execa).toHaveBeenNthCalledWith(1, 'pm2', ['--silent', 'jlist']);
    expect(execa).toHaveBeenNthCalledWith(2, 'pm2', ['delete', '1']);
    expect(execa).toHaveBeenNthCalledWith(3, 'pm2', ['delete', '2']);
    expect(execa).toHaveBeenNthCalledWith(4, 'pm2', ['delete', '4']);
    expect(execa).toHaveBeenNthCalledWith(5, 'pm2', ['delete', '5']);
  });

  it('can preserve the auto web ngrok process while stopping local services', async () => {
    const rootDir = path.resolve(process.cwd(), '../..');

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          name: 'roomote-web',
          pm_id: 1,
          pm2_env: { pm_cwd: rootDir },
        },
        {
          name: 'roomote-web-ngrok',
          pm_id: 2,
          pm2_env: { pm_cwd: rootDir },
        },
        {
          name: 'roomote-api-ngrok',
          pm_id: 3,
          pm2_env: { pm_cwd: rootDir },
        },
      ]),
    } as Awaited<ReturnType<typeof execa>>);
    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await PM2Service.stopServices({ preserveAutoWebNgrok: true });

    expect(execa).toHaveBeenCalledTimes(3);
    expect(execa).toHaveBeenNthCalledWith(1, 'pm2', ['--silent', 'jlist']);
    expect(execa).toHaveBeenNthCalledWith(2, 'pm2', ['delete', '1']);
    expect(execa).toHaveBeenNthCalledWith(3, 'pm2', ['delete', '3']);
  });
});

describe('PM2Service.validateServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries pm2 status in silent mode so jlist stdout stays JSON-only', async () => {
    vi.useFakeTimers();

    const services = [
      'roomote-api',
      'roomote-web',
      'roomote-preview-proxy',
      'roomote-bullmq',
      'roomote-controller',
      'roomote-worker-release-watcher',
    ].map((name) => ({
      name,
      pm2_env: {
        status: 'online',
        restart_time: 0,
        unstable_restarts: 0,
      },
    }));

    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify(services),
    } as Awaited<ReturnType<typeof execa>>);

    const validation = PM2Service.validateServices({
      reset: false,
      verbose: false,
      autoNgrok: false,
      skipWorkerReleaseBuild: false,
      useRelease: false,
      workerReleaseChannel: 'stable',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await validation;

    expect(execa).toHaveBeenCalledWith('pm2', ['--silent', 'jlist']);
  });

  it('includes the auto-started web ngrok tunnel in expected services', async () => {
    vi.useFakeTimers();

    const services = [
      'roomote-api',
      'roomote-web',
      'roomote-preview-proxy',
      'roomote-bullmq',
      'roomote-controller',
      'roomote-worker-release-watcher',
      'roomote-web-ngrok',
    ].map((name) => ({
      name,
      pm2_env: {
        status: 'online',
        restart_time: 0,
        unstable_restarts: 0,
      },
    }));

    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify(services),
    } as Awaited<ReturnType<typeof execa>>);

    const validation = PM2Service.validateServices({
      reset: false,
      verbose: false,
      autoNgrok: true,
      skipWorkerReleaseBuild: false,
      useRelease: false,
      workerReleaseChannel: 'stable',
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(validation).resolves.toBeUndefined();
  });
});

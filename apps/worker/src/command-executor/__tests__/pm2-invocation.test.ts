import { execa } from 'execa';

const { mockExeca } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

import {
  resolvePm2Invocation,
  ROOMOTE_BUNDLED_PM2_BINARY_PATH,
  ROOMOTE_PATH_PM2_BINARY,
} from '../command-executor';

function versionResult(exitCode: number) {
  return {
    exitCode,
    stdout: '',
    stderr: '',
  } as Awaited<ReturnType<typeof execa>>;
}

describe('resolvePm2Invocation', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers the bundled PM2 binary when it is available', async () => {
    mockExeca.mockResolvedValueOnce(versionResult(0));

    await expect(
      resolvePm2Invocation({ cwd: '/workspace/repos/acme', env }),
    ).resolves.toEqual({
      command: ROOMOTE_BUNDLED_PM2_BINARY_PATH,
      argsPrefix: [],
    });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      ROOMOTE_BUNDLED_PM2_BINARY_PATH,
      ['--version'],
      {
        cwd: '/workspace/repos/acme',
        env,
        extendEnv: false,
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 30_000,
      },
    );
  });

  it('falls back to a PATH-based PM2 binary when the bundled one is unavailable', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('spawn /usr/local/bin/pm2 ENOENT'))
      .mockResolvedValueOnce(versionResult(0));

    await expect(
      resolvePm2Invocation({ cwd: '/workspace/repos/acme', env }),
    ).resolves.toEqual({
      command: ROOMOTE_PATH_PM2_BINARY,
      argsPrefix: [],
    });

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      ROOMOTE_BUNDLED_PM2_BINARY_PATH,
      ['--version'],
      expect.any(Object),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      ROOMOTE_PATH_PM2_BINARY,
      ['--version'],
      expect.any(Object),
    );
  });

  it('reports both lookup paths when PM2 cannot be found', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('spawn /usr/local/bin/pm2 ENOENT'))
      .mockRejectedValueOnce(new Error('spawn pm2 ENOENT'));

    await expect(
      resolvePm2Invocation({ cwd: '/workspace/repos/acme', env }),
    ).rejects.toThrow(
      `Detached command failed to start under PM2: no PM2 binary was found. Expected: ${ROOMOTE_BUNDLED_PM2_BINARY_PATH} or \`${ROOMOTE_PATH_PM2_BINARY}\` on PATH.`,
    );
  });
});

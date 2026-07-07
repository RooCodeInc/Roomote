import { execa } from 'execa';

import { withAptLock } from '../package-manager';

const { mockExeca, mockWithAptLock } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
  mockWithAptLock: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('../package-manager', () => ({
  withAptLock: mockWithAptLock,
}));

import { installEmojiFont } from '../emoji-fonts';
import type { StartupLogger } from '../../../logging';

describe('installEmojiFont', () => {
  const mockedExeca = vi.mocked(execa);
  const mockedWithAptLock = vi.mocked(withAptLock);
  const createExecaResult = (
    result: Partial<Awaited<ReturnType<typeof execa>>> = {},
  ): ReturnType<typeof execa> =>
    Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      ...result,
    } as Awaited<ReturnType<typeof execa>>) as ReturnType<typeof execa>;

  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedWithAptLock.mockImplementation(async (fn) => await fn());
    mockedExeca.mockImplementation(() => createExecaResult());
  });

  it('skips package installation when the browser font packages are already installed', async () => {
    mockedExeca.mockImplementation((command) => {
      if (command === 'dpkg-query') {
        return createExecaResult({
          stdout:
            'fontconfig install ok installed\nfonts-noto-core install ok installed\nfonts-noto-color-emoji install ok installed\n',
        });
      }

      return createExecaResult();
    });

    await installEmojiFont(logger);

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(mockedExeca).toHaveBeenCalledWith(
      'dpkg-query',
      [
        '-W',
        '-f=${Package} ${Status}\\n',
        'fontconfig',
        'fonts-noto-core',
        'fonts-noto-color-emoji',
      ],
      expect.objectContaining({
        reject: false,
        stdin: 'ignore',
        stderr: 'ignore',
      }),
    );
    expect(mockedWithAptLock).not.toHaveBeenCalled();
  });

  it('installs browser font packages and refreshes the font cache when packages are missing', async () => {
    mockedExeca.mockImplementation((command) => {
      if (command === 'dpkg-query') {
        return createExecaResult({ exitCode: 1 });
      }

      return createExecaResult();
    });

    await installEmojiFont(logger);

    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      'dpkg-query',
      [
        '-W',
        '-f=${Package} ${Status}\\n',
        'fontconfig',
        'fonts-noto-core',
        'fonts-noto-color-emoji',
      ],
      expect.objectContaining({
        reject: false,
        stdin: 'ignore',
        stderr: 'ignore',
      }),
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'sudo',
      [
        '-n',
        'apt-get',
        'install',
        '-y',
        'fontconfig',
        'fonts-noto-core',
        'fonts-noto-color-emoji',
      ],
      expect.objectContaining({
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      3,
      'fc-cache',
      ['-f'],
      expect.objectContaining({
        reject: false,
        stdin: 'ignore',
      }),
    );
    expect(mockedWithAptLock).toHaveBeenCalledTimes(1);
  });
});

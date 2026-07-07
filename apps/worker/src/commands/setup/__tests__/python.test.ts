import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { isCommandAvailable } from '../command-availability';

const { mockExeca, mockIsCommandAvailable } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
  mockIsCommandAvailable: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('../command-availability', () => ({
  isCommandAvailable: mockIsCommandAvailable,
}));

import { installPython } from '../legacy-runtime-tools';
import type { StartupLogger } from '../../../logging';

describe('installPython', () => {
  const mockedExeca = vi.mocked(execa);
  const mockedIsCommandAvailable = vi.mocked(isCommandAvailable);
  const userBinDir = path.join(os.homedir(), '.local', 'bin');
  const userShimPath = path.join(userBinDir, 'python');
  const miseShimPath = path.join(
    os.homedir(),
    '.local',
    'share',
    'mise',
    'shims',
    'python',
  );

  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PATH = `${userBinDir}:${path.dirname(miseShimPath)}:/usr/local/bin:/usr/bin`;
  });

  it('skips fallback shims when python is already provided by mise', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: '/usr/bin/python3\n',
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: `${miseShimPath}\n`,
        exitCode: 0,
      } as never);

    mockedIsCommandAvailable.mockResolvedValue(true);

    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockResolvedValue(undefined as never);
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never);
    const symlinkSpy = vi
      .spyOn(fs.promises, 'symlink')
      .mockResolvedValue(undefined as never);
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockResolvedValue(undefined as never);

    await installPython(logger);

    expect(mockedIsCommandAvailable).toHaveBeenCalledWith('python');
    expect(rmSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
    expect(logger.debug.warn).not.toHaveBeenCalledWith(
      'python is not available after installPython completed; creating emergency fallback shim',
    );
  });

  it('removes a stale user-local shim so the fallback PATH entry can win', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: '/usr/bin/python3\n',
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: `${userShimPath}\n`,
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: `${miseShimPath}\n`,
        exitCode: 0,
      } as never);

    mockedIsCommandAvailable.mockResolvedValue(true);

    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockResolvedValue(undefined as never);
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never);
    const symlinkSpy = vi
      .spyOn(fs.promises, 'symlink')
      .mockResolvedValue(undefined as never);
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockResolvedValue(undefined as never);

    await installPython(logger);

    expect(rmSpy).toHaveBeenCalledWith(userShimPath, {
      force: true,
    });
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'command -v "$1"', '_', 'python'],
      { reject: false, stdin: 'ignore', stderr: 'ignore' },
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      3,
      'bash',
      [
        '-lc',
        'export PATH="$1"; command -v "$2"',
        '_',
        `${path.dirname(miseShimPath)}:/usr/local/bin:/usr/bin`,
        'python',
      ],
      { reject: false, stdin: 'ignore', stderr: 'ignore' },
    );
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
    expect(mockedIsCommandAvailable).toHaveBeenCalledWith('python');
  });

  it('creates an emergency fallback shim when python is still unavailable at the end', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: '/usr/bin/python3\n',
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: `${userShimPath}\n`,
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: `${miseShimPath}\n`,
        exitCode: 0,
      } as never);

    mockedIsCommandAvailable.mockResolvedValue(false);

    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockResolvedValue(undefined as never);
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never);
    const symlinkSpy = vi
      .spyOn(fs.promises, 'symlink')
      .mockResolvedValue(undefined as never);
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockResolvedValue(undefined as never);

    await installPython(logger);

    expect(rmSpy).toHaveBeenNthCalledWith(1, userShimPath, {
      force: true,
    });
    expect(mkdirSpy).toHaveBeenCalledWith(userBinDir, {
      recursive: true,
    });
    expect(rmSpy).toHaveBeenNthCalledWith(2, userShimPath, {
      force: true,
    });
    expect(symlinkSpy).toHaveBeenCalledWith('/usr/bin/python3', userShimPath);
    expect(accessSpy).not.toHaveBeenCalled();
    expect(logger.debug.warn).toHaveBeenCalledWith(
      'python is not available after installPython completed; creating emergency fallback shim',
    );
  });

  it('returns cleanly when the emergency fallback has no python3 to point at', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: '',
        exitCode: 1,
      } as never)
      .mockResolvedValueOnce({
        stdout: '',
        exitCode: 0,
      } as never)
      .mockResolvedValueOnce({
        stdout: '',
        exitCode: 1,
      } as never)
      .mockResolvedValueOnce({
        stdout: '',
        exitCode: 1,
      } as never);

    mockedIsCommandAvailable.mockResolvedValue(false);

    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockResolvedValue(undefined as never);
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never);
    const symlinkSpy = vi
      .spyOn(fs.promises, 'symlink')
      .mockResolvedValue(undefined as never);
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockResolvedValue(undefined as never);

    await expect(installPython(logger)).resolves.toBeUndefined();

    expect(mockedIsCommandAvailable).toHaveBeenCalledWith('python');
    expect(rmSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
    expect(logger.debug.warn).toHaveBeenCalledWith(
      'python is not available after installPython completed; creating emergency fallback shim',
    );
  });
});

import { execa } from 'execa';

import { isCommandAvailable } from '../command-availability';
import { withAptLock } from '../package-manager';

const { mockExeca, mockIsCommandAvailable, mockWithAptLock } = vi.hoisted(
  () => ({
    mockExeca: vi.fn(),
    mockIsCommandAvailable: vi.fn(),
    mockWithAptLock: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
  }),
);

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('../command-availability', () => ({
  isCommandAvailable: mockIsCommandAvailable,
}));

vi.mock('../package-manager', () => ({
  withAptLock: mockWithAptLock,
}));

import { installBubblewrap } from '../legacy-runtime-tools';
import type { StartupLogger } from '../../../logging';

describe('installBubblewrap', () => {
  const mockedExeca = vi.mocked(execa);
  const mockedIsCommandAvailable = vi.mocked(isCommandAvailable);
  const mockedWithAptLock = vi.mocked(withAptLock);

  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedWithAptLock.mockImplementation(async (fn) => await fn());
    mockedExeca.mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);
  });

  it('skips apt when bwrap is already available', async () => {
    mockedIsCommandAvailable.mockResolvedValue(true);

    await installBubblewrap(logger);

    expect(mockedExeca).not.toHaveBeenCalled();
    expect(mockedWithAptLock).not.toHaveBeenCalled();
  });

  it('installs bubblewrap through apt for older images', async () => {
    mockedIsCommandAvailable.mockResolvedValue(false);

    await installBubblewrap(logger);

    expect(logger.debug.log).toHaveBeenCalledWith(
      'Installing bubblewrap via apt',
    );
    expect(mockedWithAptLock).toHaveBeenCalledTimes(1);
    expect(mockedExeca).toHaveBeenCalledWith(
      'sudo',
      [
        '-n',
        'env',
        'DEBIAN_FRONTEND=noninteractive',
        'apt-get',
        'install',
        '-y',
        'bubblewrap',
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
    );
  });

  it('logs and continues when the compatibility install fails', async () => {
    mockedIsCommandAvailable.mockResolvedValue(false);
    mockedExeca.mockRejectedValue(new Error('apt unavailable'));

    await expect(installBubblewrap(logger)).resolves.toBeUndefined();
    expect(logger.debug.warn).toHaveBeenCalledWith(
      'Failed to install bubblewrap compatibility fallback: apt unavailable',
    );
  });
});

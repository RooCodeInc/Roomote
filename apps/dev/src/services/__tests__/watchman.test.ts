import path from 'path';

import { execa } from 'execa';

import { WatchmanService } from '../watchman';

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

describe('WatchmanService.checkInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts watchman when it is already installed', async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
    } as Awaited<ReturnType<typeof execa>>);

    await WatchmanService.checkInstalled();

    expect(execa).toHaveBeenNthCalledWith(1, 'watchman', ['--version'], {
      reject: false,
    });
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('accepts inotifywait when watchman is unavailable', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('watchman not found'))
      .mockResolvedValueOnce({
        exitCode: 0,
      } as Awaited<ReturnType<typeof execa>>);

    await WatchmanService.checkInstalled();

    expect(execa).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'command -v inotifywait'],
      {
        reject: false,
      },
    );
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it('runs the repo installer when the available watcher exits non-zero', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
      } as Awaited<ReturnType<typeof execa>>)
      .mockRejectedValueOnce(new Error('inotifywait not found'))
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        exitCode: 0,
      } as Awaited<ReturnType<typeof execa>>);

    await WatchmanService.checkInstalled();

    expect(execa).toHaveBeenNthCalledWith(
      3,
      'bash',
      ['scripts/install-watchman.sh'],
      {
        cwd: path.resolve(process.cwd(), '../..'),
        stdio: 'inherit',
      },
    );

    expect(execa).toHaveBeenNthCalledWith(4, 'watchman', ['--version'], {
      reject: false,
    });
    expect(execa).toHaveBeenCalledTimes(4);
  });

  it('surfaces the repo installer when automatic installation fails', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('watchman not found'))
      .mockResolvedValueOnce({
        exitCode: 1,
      } as Awaited<ReturnType<typeof execa>>)
      .mockRejectedValueOnce(new Error('installer failed'));

    await expect(WatchmanService.checkInstalled()).rejects.toThrow(
      './scripts/install-watchman.sh',
    );
  });
});

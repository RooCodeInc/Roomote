import path from 'path';

import { execa } from 'execa';

import { DatabaseService } from '../database';

const spinner = {
  succeed: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
};

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: () => spinner,
  })),
}));

describe('DatabaseService.migrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);
  });

  it('runs db migrate', async () => {
    await DatabaseService.migrate(false);

    const expectedRootDir = path.resolve(process.cwd(), '../..');
    const calls = vi.mocked(execa).mock.calls;

    expect(calls[0]).toEqual([
      'pnpm',
      ['db:migrate'],
      {
        cwd: expectedRootDir,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(spinner.warn).not.toHaveBeenCalled();
  });
});

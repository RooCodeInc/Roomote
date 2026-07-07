import { execa } from 'execa';

import {
  resolvePm2Invocation,
  ROOMOTE_BUNDLED_PM2_BINARY_PATH,
  ROOMOTE_PATH_PM2_BINARY,
} from '../command-executor';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('resolvePm2Invocation', () => {
  const mockedExeca = vi.mocked(execa);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed when bundled and PATH PM2 are unavailable instead of invoking npx', async () => {
    mockedExeca.mockImplementation((async (
      command: string | URL,
      args?: readonly string[],
    ) => {
      expect(args).toEqual(['--version']);

      if (command === 'npx') {
        throw new Error('npx should not be used for PM2 fallback');
      }

      return { exitCode: 1 } as Awaited<ReturnType<typeof execa>>;
    }) as typeof execa);

    let error: Error | undefined;

    try {
      await resolvePm2Invocation({
        cwd: '/workspace/repos/acme',
        env: { PATH: '/tmp/acme/bin' },
      });
    } catch (caughtError) {
      error = caughtError as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toBe(
      `Detached command failed to start under PM2: no PM2 binary was found. Expected: ${ROOMOTE_BUNDLED_PM2_BINARY_PATH} or \`${ROOMOTE_PATH_PM2_BINARY}\` on PATH.`,
    );
    expect(error?.message).not.toContain(
      'Refresh the worker image or sandbox snapshot',
    );

    expect(mockedExeca.mock.calls.map(([command]) => command)).toEqual([
      ROOMOTE_BUNDLED_PM2_BINARY_PATH,
      ROOMOTE_PATH_PM2_BINARY,
    ]);
    expect(mockedExeca.mock.calls.some(([command]) => command === 'npx')).toBe(
      false,
    );
  });
});

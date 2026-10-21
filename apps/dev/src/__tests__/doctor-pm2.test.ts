import { execa } from 'execa';

import { runDoctor } from '../doctor';

vi.mock('execa', () => ({ execa: vi.fn() }));

const mockedExeca = execa as unknown as {
  mockImplementation: (
    implementation: (
      command: string,
      args?: string[],
      options?: { timeout?: number },
    ) => Promise<{ stdout: string }>,
  ) => void;
};

describe('doctor PM2 inspection recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports a timed-out PM2 inspection, continues diagnostics, and retries on the next run', async () => {
    let stalled = true;
    vi.stubEnv('R_TEAMS_BOT_APP_ID', '');
    vi.stubEnv('R_TEAMS_BOT_APP_PASSWORD', '');
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    mockedExeca.mockImplementation(async (command, args, options) => {
      if (command === 'pm2') {
        expect(args).toEqual(['--silent', 'jlist']);
        expect(options).toMatchObject({ timeout: 10_000 });
        if (stalled) {
          throw new Error(
            'Command timed out after 10000 milliseconds: pm2 --silent jlist',
          );
        }
        return { stdout: '[]' };
      }
      return { stdout: '' };
    });

    const first = await runDoctor();
    expect(
      first.find((check) => check.name === 'Runtime services'),
    ).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('timed out after 10000 milliseconds'),
    });
    expect(
      first.find((check) => check.name === 'Task runtime tooling'),
    ).toMatchObject({ status: 'pass' });
    expect(first.find((check) => check.name === 'api liveness')).toMatchObject({
      status: 'pass',
    });
    expect(fetch).toHaveBeenCalledTimes(7);

    stalled = false;
    const retried = await runDoctor();
    const runtime = retried.find((check) => check.name === 'Runtime services');
    expect(runtime?.detail).toContain('missing roomote-api');
    expect(runtime?.detail).not.toContain('timed out');
    expect(fetch).toHaveBeenCalledTimes(14);
  });
});

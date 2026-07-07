import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { startBackgroundProcess } from '../command-executor';

describe('startBackgroundProcess', () => {
  const env = { TEST_VAR: 'test_value' };

  it('should start a valid command without throwing', async () => {
    const logfile = join('/tmp', `bg-test-ok-${Date.now()}.log`);

    await expect(
      startBackgroundProcess({
        cmdLine: 'echo "hello from background"',
        cwd: '/tmp',
        env,
        logfile,
      }),
    ).resolves.toBeUndefined();
  });

  it('should throw when the command is not found', async () => {
    const logfile = join('/tmp', `bg-test-notfound-${Date.now()}.log`);

    await expect(
      startBackgroundProcess({
        cmdLine: '/nonexistent/binary --flag',
        cwd: '/tmp',
        env,
        logfile,
      }),
    ).rejects.toThrow('Detached command failed to start');
  });

  it('should throw when the command exits immediately with an error', async () => {
    const logfile = join('/tmp', `bg-test-exit1-${Date.now()}.log`);

    await expect(
      startBackgroundProcess({
        cmdLine: 'exit 1',
        cwd: '/tmp',
        env,
        logfile,
      }),
    ).rejects.toThrow('Detached command failed to start');
  });

  it('should write output to the logfile on success', async () => {
    const logfile = join('/tmp', `bg-test-log-${Date.now()}.log`);

    await startBackgroundProcess({
      cmdLine: 'echo "log output"',
      cwd: '/tmp',
      env,
      logfile,
    });

    // Give the process time to write and flush output.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const content = readFileSync(logfile, 'utf-8');
    expect(content).toContain('log output');

    unlinkSync(logfile);
  });

  it('should write error output to the logfile on failure', async () => {
    const logfile = join('/tmp', `bg-test-errlog-${Date.now()}.log`);

    await startBackgroundProcess({
      cmdLine: 'echo "error info" >&2 && exit 1',
      cwd: '/tmp',
      env,
      logfile,
    }).catch(() => {});

    // Give the process time to write and flush output.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const content = readFileSync(logfile, 'utf-8');
    expect(content.length).toBeGreaterThan(0);

    unlinkSync(logfile);
  });

  it('should support inline env vars with continuation lines', async () => {
    const logfile = join('/tmp', `bg-test-envcont-${Date.now()}.log`);

    await startBackgroundProcess({
      cmdLine: `MY_VAR=hello OTHER_VAR=world bash -c 'echo "$MY_VAR $OTHER_VAR"'`,
      cwd: '/tmp',
      env,
      logfile,
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const content = readFileSync(logfile, 'utf-8');
    expect(content).toContain('hello world');

    unlinkSync(logfile);
  });

  it('should not inherit ambient process env vars', async () => {
    const logfile = join('/tmp', `bg-test-no-inherit-${Date.now()}.log`);
    const originalAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'production';

    try {
      await startBackgroundProcess({
        cmdLine: 'printf "%s" "${APP_ENV:-missing}"',
        cwd: '/tmp',
        env,
        logfile,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const content = readFileSync(logfile, 'utf-8');
      expect(content).toContain('missing');
      expect(content).not.toContain('production');
    } finally {
      if (originalAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = originalAppEnv;
      }

      unlinkSync(logfile);
    }
  });
});

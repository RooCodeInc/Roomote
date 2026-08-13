import {
  DetachedWorkerLaunchError,
  buildDetachedWorkerExitError,
} from '../detached-worker-launch';

describe('buildDetachedWorkerExitError', () => {
  it('includes captured stderr and stdout in the error message', () => {
    const error = buildDetachedWorkerExitError('snapshot', {
      exitCode: 1,
      commandId: 'cmd-1',
      stderr: 'Caught error: something broke\n',
      stdout: 'booting\n',
    });

    expect(error).toBeInstanceOf(DetachedWorkerLaunchError);
    expect(error.message).toBe(
      'Detached "worker snapshot" exited immediately with code 1\n' +
        'stderr: Caught error: something broke\n' +
        'stdout: booting',
    );
    expect(error.details).toMatchObject({
      commandId: 'cmd-1',
      exitCode: 1,
      stderr: 'Caught error: something broke',
      stdout: 'booting',
    });
  });

  it('omits output sections when the streams are empty', () => {
    const error = buildDetachedWorkerExitError('run', {
      exitCode: 7,
      stderr: '  ',
    });

    expect(error.message).toBe(
      'Detached "worker run" exited immediately with code 7',
    );
    expect(error.details).toEqual({ commandId: null, exitCode: 7 });
  });

  it('redacts every env assignment echoed by the shell, including quoted tokens and names without secret suffixes', () => {
    const error = buildDetachedWorkerExitError('run', {
      exitCode: 126,
      stderr:
        'bash: env AUTH_TOKEN=abc123 ' +
        "'ROOMOTE_AUTH_BYPASS_VALUE=byp 4ss' " +
        '"SANDBOX_EXPIRES_AT_MS=17 55 06" ' +
        "SOME_API_KEY='s3cret value' " +
        'worker run 5: Argument list too long (exit=126)',
    });

    expect(error.message).toContain('AUTH_TOKEN=<redacted>');
    expect(error.message).toContain("'ROOMOTE_AUTH_BYPASS_VALUE=<redacted>'");
    expect(error.message).toContain('"SANDBOX_EXPIRES_AT_MS=<redacted>"');
    expect(error.message).toContain('SOME_API_KEY=<redacted>');
    expect(error.message).not.toContain('abc123');
    expect(error.message).not.toContain('byp 4ss');
    expect(error.message).not.toContain('17 55 06');
    expect(error.message).not.toContain('s3cret');
    expect(error.details.stderr).not.toContain('abc123');
    // Lowercase diagnostic text is not env-shaped and stays readable.
    expect(error.message).toContain('(exit=126)');
  });

  it('truncates oversized output to keep run errors readable', () => {
    const error = buildDetachedWorkerExitError('run', {
      exitCode: 1,
      stderr: 'x'.repeat(2_000),
    });

    expect(error.details.stderr).toHaveLength(503);
    expect(error.details.stderr).toMatch(/\.\.\.$/);
  });
});

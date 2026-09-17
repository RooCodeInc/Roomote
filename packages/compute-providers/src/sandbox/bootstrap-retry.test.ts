import { isTransientBootstrapError } from './bootstrap-retry';

describe('isTransientBootstrapError', () => {
  it.each([
    ['undici cut stream', new Error('terminated')],
    [
      'reset socket',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ],
    [
      'fetch failure with socket cause',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      }),
    ],
    [
      'proxy 502 status',
      Object.assign(new Error('Broker request failed'), { status: 502 }),
    ],
    ['broker exec stream error', new Error('Broker exec error: stream closed')],
  ])('treats %s as transient', (_label, error) => {
    expect(isTransientBootstrapError(error)).toBe(true);
  });

  it.each([
    [
      'install exit code',
      new Error('Modal worker install failed with exit code 1: apt failed'),
    ],
    [
      'install exit code wrapped in a 502-looking message',
      new Error('Modal worker install failed with exit code 502: no output'),
    ],
    ['validation error', new Error('modalBaseImageRef is required')],
    ['plain string', 'nope'],
  ])('does not treat %s as transient', (_label, error) => {
    expect(isTransientBootstrapError(error)).toBe(false);
  });
});

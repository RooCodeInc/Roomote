import { describe, expect, it } from 'vitest';

import { isLoopbackHostname } from '../hostname';

describe('isLoopbackHostname', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['foo.localhost', true],
    ['bar.baz.localhost', true],
    ['127.0.0.1', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['[::1]', true],
    ['example.com', false],
    ['notlocalhost', false],
    ['localhost.example.com', false],
    ['192.168.1.1', false],
    ['', false],
  ])('isLoopbackHostname(%j) === %s', (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});

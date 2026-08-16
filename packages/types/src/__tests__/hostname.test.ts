import { describe, expect, it } from 'vitest';

import { isLoopbackHostname } from '../hostname';

describe('isLoopbackHostname', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['foo.localhost', true],
    ['bar.baz.localhost', true],
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.1.2.3', true],
    ['127.255.255.255', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['[::1]', true],
    ['::', true],
    ['[::]', true],
    ['example.com', false],
    ['notlocalhost', false],
    ['localhost.example.com', false],
    ['192.168.1.1', false],
    ['127.0.0.256', false],
    ['128.0.0.1', false],
    ['1270.0.0.1', false],
    ['127.0.0.1.example.com', false],
    ['', false],
  ])('isLoopbackHostname(%j) === %s', (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});

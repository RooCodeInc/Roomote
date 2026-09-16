import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      multi: vi.fn(() => {
        const ops: Array<() => unknown> = [];
        const chain = {
          get: (key: string) => {
            ops.push(() => store.get(key) ?? null);
            return chain;
          },
          del: (key: string) => {
            ops.push(() => (store.delete(key) ? 1 : 0));
            return chain;
          },
          exec: async () => ops.map((op) => [null, op()]),
        };
        return chain;
      }),
    },
  };
});
vi.mock('@roomote/redis', () => ({ getRedis: () => mocks.redis }));

import {
  consumeMobileHandoffToken,
  isAllowedHandoffRedirect,
  storeMobileHandoffToken,
} from '../mobile-handoff';

describe('mobile handoff', () => {
  it('only redirects to the app scheme', () => {
    expect(isAllowedHandoffRedirect('roomote://auth')).toBe(true);
    expect(isAllowedHandoffRedirect('roomote://auth?x=1')).toBe(true);
    expect(isAllowedHandoffRedirect('https://evil.example/auth')).toBe(false);
    expect(isAllowedHandoffRedirect('javascript:alert(1)')).toBe(false);
    expect(isAllowedHandoffRedirect('not a url')).toBe(false);
  });

  it('stores a token under a single-use code with a TTL', async () => {
    const code = await storeMobileHandoffToken('token.sig');
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(mocks.redis.set).toHaveBeenCalledWith(
      `mobile-handoff:${code}`,
      'token.sig',
      'EX',
      60,
    );
    expect(await consumeMobileHandoffToken(code)).toBe('token.sig');
    expect(await consumeMobileHandoffToken(code)).toBeNull();
  });

  it('rejects malformed codes without touching redis', async () => {
    mocks.redis.multi.mockClear();
    expect(await consumeMobileHandoffToken('short')).toBeNull();
    expect(await consumeMobileHandoffToken('../../etc')).toBeNull();
    expect(mocks.redis.multi).not.toHaveBeenCalled();
  });
});

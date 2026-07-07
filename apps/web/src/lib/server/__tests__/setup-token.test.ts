const mockEnvState = vi.hoisted(() => ({
  SETUP_TOKEN: undefined as string | undefined,
}));

vi.mock('../env', () => ({
  Env: new Proxy(
    {},
    {
      get: (_target, prop) => mockEnvState[prop as keyof typeof mockEnvState],
    },
  ),
}));

import {
  assertSetupTokenValid,
  isSetupTokenRequired,
  isSetupTokenValid,
} from '../setup-token';

describe('setup-token', () => {
  afterEach(() => {
    mockEnvState.SETUP_TOKEN = undefined;
    vi.unstubAllEnvs();
  });

  describe('in local development with no SETUP_TOKEN configured', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('APP_ENV', 'development');
    });

    it('does not require a token', () => {
      expect(isSetupTokenRequired()).toBe(false);
    });

    it('allows tokenless bootstrap', () => {
      expect(isSetupTokenValid(undefined)).toBe(true);
      expect(isSetupTokenValid('anything')).toBe(true);
      expect(() => assertSetupTokenValid(undefined)).not.toThrow();
    });
  });

  describe('on a non-local deployment with no SETUP_TOKEN configured', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENV', 'production');
    });

    it('requires a token that cannot be satisfied until SETUP_TOKEN is set', () => {
      expect(isSetupTokenRequired()).toBe(true);
      expect(isSetupTokenValid(undefined)).toBe(false);
      expect(isSetupTokenValid('anything')).toBe(false);
      expect(() => assertSetupTokenValid('anything')).toThrow(
        'A valid setup token is required',
      );
    });
  });

  describe('when only NODE_ENV=production is set (APP_ENV unset)', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENV', undefined);
    });

    it('fails closed even though resolveAppEnv falls back to development', () => {
      expect(isSetupTokenRequired()).toBe(true);
      expect(isSetupTokenValid(undefined)).toBe(false);
      expect(isSetupTokenValid('anything')).toBe(false);
    });
  });

  describe('with SETUP_TOKEN configured', () => {
    beforeEach(() => {
      mockEnvState.SETUP_TOKEN = 'expected-token';
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENV', 'production');
    });

    it('requires a token', () => {
      expect(isSetupTokenRequired()).toBe(true);
    });

    it('accepts the matching token', () => {
      expect(isSetupTokenValid('expected-token')).toBe(true);
      expect(() => assertSetupTokenValid('expected-token')).not.toThrow();
    });

    it('rejects missing and mismatched tokens', () => {
      expect(isSetupTokenValid(undefined)).toBe(false);
      expect(isSetupTokenValid('')).toBe(false);
      expect(isSetupTokenValid('wrong-token')).toBe(false);
      expect(isSetupTokenValid('expected-token-longer')).toBe(false);
      expect(() => assertSetupTokenValid('wrong-token')).toThrow(
        'A valid setup token is required',
      );
    });
  });
});

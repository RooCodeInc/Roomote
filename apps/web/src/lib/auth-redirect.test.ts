import { getSafeSignInRedirectPath } from './auth-redirect';

describe('getSafeSignInRedirectPath', () => {
  it('preserves a safe local path and uses the first repeated value', () => {
    expect(
      getSafeSignInRedirectPath(
        ['/tasks?tab=active#details', '/settings'],
        '/',
      ),
    ).toBe('/tasks?tab=active#details');
  });

  it.each([
    undefined,
    'https://example.com',
    '//example.com',
    String.raw`/\example.com`,
    '/sign-in',
    '/sign-in/oauth',
  ])('uses the fallback for unsafe destination %s', (redirectPath) => {
    expect(getSafeSignInRedirectPath(redirectPath, '/fallback')).toBe(
      '/fallback',
    );
  });
});

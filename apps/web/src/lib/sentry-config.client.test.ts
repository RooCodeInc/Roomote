import {
  isWebSentryEnabled,
  resolveWebSentryEnvironment,
  resolveWebSentryRelease,
} from './sentry-config';

describe('web sentry config', () => {
  it('disables Sentry in development', () => {
    expect(isWebSentryEnabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('keeps Sentry enabled outside development', () => {
    expect(isWebSentryEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(isWebSentryEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('uses canonical app env when present', () => {
    expect(
      resolveWebSentryEnvironment({
        R_APP_ENV: 'preview',
        NODE_ENV: 'production',
      }),
    ).toBe('preview');
  });

  it('falls back to development when node env is development', () => {
    expect(
      resolveWebSentryEnvironment({
        NODE_ENV: 'development',
      }),
    ).toBe('development');
  });

  it('falls back to production outside development when app env is unset', () => {
    expect(
      resolveWebSentryEnvironment({
        NODE_ENV: 'production',
      }),
    ).toBe('production');
  });

  it('prefers server-side commit env vars for release attribution', () => {
    expect(
      resolveWebSentryRelease({
        NEXT_PUBLIC_SENTRY_RELEASE: ' client-release ',
        VERCEL_GIT_COMMIT_SHA: ' vercel-sha ',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('client-release');
  });

  it('uses github sha when vercel commit metadata is unavailable', () => {
    expect(
      resolveWebSentryRelease({
        GITHUB_SHA: ' github-sha ',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('github-sha');
  });

  it('uses the Vercel deployment id when commit metadata is unavailable', () => {
    expect(
      resolveWebSentryRelease({
        NODE_ENV: 'production',
        VERCEL_DEPLOYMENT_ID: ' dpl_123 ',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('dpl_123');
  });

  it('uses release version as a fallback', () => {
    expect(
      resolveWebSentryRelease({
        RELEASE_VERSION: ' v1.2.3 ',
      }),
    ).toBe('v1.2.3');
  });

  it('omits release attribution when all release env vars are blank', () => {
    expect(
      resolveWebSentryRelease({
        NEXT_PUBLIC_SENTRY_RELEASE: ' ',
        VERCEL_GIT_COMMIT_SHA: ' ',
        GITHUB_SHA: ' ',
        VERCEL_DEPLOYMENT_ID: ' ',
        RELEASE_VERSION: ' ',
      }),
    ).toBeUndefined();
  });
});

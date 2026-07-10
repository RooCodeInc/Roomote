import { getDefaultDocsUrl, resolveAppEnv } from './app-env';

describe('resolveAppEnv', () => {
  it('maps APP_ENV and R_APP_ENV values', () => {
    expect(
      resolveAppEnv({
        NODE_ENV: 'test',
        APP_ENV: 'preview',
      } as NodeJS.ProcessEnv),
    ).toBe('preview');
    expect(
      resolveAppEnv({
        NODE_ENV: 'test',
        R_APP_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toBe('production');
  });
});

describe('getDefaultDocsUrl', () => {
  it('returns the public docs site URL in every environment', () => {
    expect(getDefaultDocsUrl('development')).toBe('https://docs.roomote.dev');
    expect(getDefaultDocsUrl('preview')).toBe('https://docs.roomote.dev');
    expect(getDefaultDocsUrl('production')).toBe('https://docs.roomote.dev');
  });
});

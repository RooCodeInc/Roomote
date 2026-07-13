import { getBetterAuthBaseUrlConfig } from '../better-auth-base-url';

describe('getBetterAuthBaseUrlConfig', () => {
  const originalAppEnv = process.env.R_APP_ENV;
  const originalPreviewDomains = process.env.R_PREVIEW_DOMAINS;

  afterEach(() => {
    if (originalAppEnv === undefined) {
      delete process.env.R_APP_ENV;
    } else {
      process.env.R_APP_ENV = originalAppEnv;
    }

    if (originalPreviewDomains === undefined) {
      delete process.env.R_PREVIEW_DOMAINS;
    } else {
      process.env.R_PREVIEW_DOMAINS = originalPreviewDomains;
    }
  });

  it('keeps a fixed canonical base URL in production', () => {
    process.env.R_APP_ENV = 'production';

    expect(
      getBetterAuthBaseUrlConfig({
        roomoteAppUrl: 'https://app.roomote.example.com',
      }),
    ).toBe('https://app.roomote.example.com');
  });

  it('allows localhost and public preview hosts in development', () => {
    process.env.R_APP_ENV = 'development';

    const result = getBetterAuthBaseUrlConfig({
      previewDomainsRaw: 'preview-john.ngrok.app',
      roomoteAppUrl: 'https://roomote-john.ngrok.app',
    });

    expect(result).toEqual({
      allowedHosts: expect.arrayContaining([
        'roomote-john.ngrok.app',
        'localhost',
        'localhost:*',
        '127.0.0.1',
        '127.0.0.1:*',
        '*.ngrok.app',
        '*.preview-john.ngrok.app',
      ]),
      fallback: 'https://roomote-john.ngrok.app',
      protocol: 'auto',
    });
  });

  it('preserves the canonical localhost port in development', () => {
    process.env.R_APP_ENV = 'development';

    const result = getBetterAuthBaseUrlConfig({
      roomoteAppUrl: 'http://localhost:13000',
    });

    expect(result).toEqual({
      allowedHosts: expect.arrayContaining([
        'localhost:13000',
        'localhost',
        'localhost:*',
        '127.0.0.1',
        '127.0.0.1:*',
      ]),
      fallback: 'http://localhost:13000',
      protocol: 'auto',
    });
  });
});

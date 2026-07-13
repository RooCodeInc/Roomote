import { assessBrowserOrigin } from '../browser-origin-trust';

describe('assessBrowserOrigin', () => {
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

  describe('in production', () => {
    beforeEach(() => {
      process.env.R_APP_ENV = 'production';
    });

    it('trusts only the exact canonical origin', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://app.roomote.example.com',
          roomoteAppUrl: 'https://app.roomote.example.com',
        }),
      ).toEqual({
        canonicalOrigin: 'https://app.roomote.example.com',
        trusted: true,
      });
    });

    it('rejects a custom domain the deployment was not told about', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://app.roomote.example.dev',
          roomoteAppUrl: 'https://web-production-1234.up.railway.example.app',
        }),
      ).toEqual({
        canonicalOrigin: 'https://web-production-1234.up.railway.example.app',
        trusted: false,
      });
    });

    it('rejects a protocol downgrade of the canonical host', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'http://app.roomote.example.com',
          roomoteAppUrl: 'https://app.roomote.example.com',
        }).trusted,
      ).toBe(false);
    });

    it('rejects a malformed browser origin', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'not-an-origin',
          roomoteAppUrl: 'https://app.roomote.example.com',
        }).trusted,
      ).toBe(false);
    });
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.R_APP_ENV = 'development';
    });

    it('trusts the canonical host', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://roomote-john.ngrok.app',
          roomoteAppUrl: 'https://roomote-john.ngrok.app',
        }).trusted,
      ).toBe(true);
    });

    it('trusts loopback hosts on any port', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'http://localhost:4444',
          roomoteAppUrl: 'http://localhost:13000',
        }).trusted,
      ).toBe(true);

      expect(
        assessBrowserOrigin({
          browserOrigin: 'http://127.0.0.1:13000',
          roomoteAppUrl: 'http://localhost:13000',
        }).trusted,
      ).toBe(true);
    });

    it('trusts configured preview domains as wildcard subdomains', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://task-abc.previews.roomote.example.com',
          previewDomainsRaw: 'previews.roomote.example.com',
          roomoteAppUrl: 'https://roomote.example.com',
        }).trusted,
      ).toBe(true);
    });

    it('rejects unrelated hosts', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://evil.example.com',
          previewDomainsRaw: 'previews.roomote.example.com',
          roomoteAppUrl: 'https://roomote.example.com',
        }).trusted,
      ).toBe(false);
    });

    it('does not treat the bare preview root as a wildcard match', () => {
      expect(
        assessBrowserOrigin({
          browserOrigin: 'https://previews.roomote.example.com',
          previewDomainsRaw: 'previews.roomote.example.com',
          roomoteAppUrl: 'https://roomote.example.com',
        }).trusted,
      ).toBe(false);
    });
  });
});

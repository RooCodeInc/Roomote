import {
  buildTaskPreviewUrls,
  getPreviewProxyBaseUrl,
  getPrimaryPreviewUrlWithPath,
} from '../preview-urls';

describe('preview-urls utilities', () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
  const originalSuffix = process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
    delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
  });

  afterEach(() => {
    if (originalBaseUrl !== undefined) {
      process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
    }

    if (originalSuffix !== undefined) {
      process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX = originalSuffix;
    } else {
      delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
    }
  });

  describe('getPreviewProxyBaseUrl', () => {
    it('returns the default URL when env var is not set', () => {
      expect(getPreviewProxyBaseUrl()).toBe(
        'http://roomotepreview.localhost:18081',
      );
    });

    it('returns the configured URL when env var is set', () => {
      process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL =
        'https://custom.preview.example.com';

      expect(getPreviewProxyBaseUrl()).toBe(
        'https://custom.preview.example.com',
      );
    });
  });

  describe('buildTaskPreviewUrls', () => {
    it('returns null when machineDomains is missing', () => {
      expect(buildTaskPreviewUrls('task-123', null)).toBeNull();
      expect(buildTaskPreviewUrls('task-123', undefined)).toBeNull();
    });

    it('builds preview URLs for each machine domain', () => {
      expect(
        buildTaskPreviewUrls('task-123', {
          EDITOR: 'https://editor.vercel.run',
          API: 'https://api.vercel.run',
          WEB: 'https://web.vercel.run',
        }),
      ).toEqual({
        EDITOR: 'http://task-123-editor.roomotepreview.localhost:18081',
        API: 'http://task-123-api.roomotepreview.localhost:18081',
        WEB: 'http://task-123-web.roomotepreview.localhost:18081',
      });
    });

    it('builds preview URLs for custom machine domains', () => {
      expect(
        buildTaskPreviewUrls('task-123', {
          DOCS: 'https://docs.vercel.run',
        }),
      ).toEqual({
        DOCS: 'http://task-123-docs.roomotepreview.localhost:18081',
      });
    });
  });

  describe('getPrimaryPreviewUrlWithPath', () => {
    const previewUrls = {
      GUI: 'https://task-123-gui.preview.roomote.run',
      WEB: 'https://task-123-web.preview.roomote.run',
    };

    const machineDomains = {
      GUI: 'https://gui.vercel.run',
      WEB: 'https://web.vercel.run',
    };

    it('ignores legacy GUI domains when choosing the primary preview target', () => {
      expect(
        getPrimaryPreviewUrlWithPath(previewUrls, null, machineDomains, {
          WEB: '/app',
        }),
      ).toBe('https://task-123-web.preview.roomote.run/app');
    });

    it('ignores legacy GUI machine domains when picking the primary preview target', () => {
      expect(
        getPrimaryPreviewUrlWithPath(
          previewUrls,
          'https://gui.vercel.run',
          machineDomains,
          {
            WEB: '/app',
          },
        ),
      ).toBe('https://task-123-web.preview.roomote.run/app');
    });

    it('ignores legacy GUI primary port hints when picking the primary preview target', () => {
      const previewUrls = {
        GUI: 'https://task-123-gui.preview.roomote.run',
        WEB: 'https://task-123-web.preview.roomote.run',
      };

      expect(
        getPrimaryPreviewUrlWithPath(
          previewUrls,
          'https://gui.vercel.run',
          machineDomains,
          {
            WEB: '/app',
          },
          'GUI',
        ),
      ).toBe('https://task-123-web.preview.roomote.run/app');
    });
  });
});

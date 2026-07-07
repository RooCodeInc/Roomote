import type { PreviewSettingsSnapshot } from './index';
import { applyPreviewRuntimeUiMock } from './index';

describe('applyPreviewRuntimeUiMock', () => {
  const runtime: PreviewSettingsSnapshot['effectiveConfig'] = {
    previewProxyBaseUrl: 'http://roomotepreview.localhost:18081',
    previewProxyHostname: 'roomotepreview.localhost',
    previewDomains: ['localhost', '127.0.0.1', 'roomotepreview.localhost'],
    roomotePreviewDomain: 'roomotepreview.localhost',
    primaryPreviewDomain: 'roomotepreview.localhost',
    exampleHostname: 'abc123def4567-web.roomotepreview.localhost',
    validation: {
      status: 'pass',
      reason: 'config_ready',
      summary: 'Config is valid and checked',
      details: [],
      checkedHostname: null,
    },
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the original runtime when the mock env var is unset', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');

    expect(applyPreviewRuntimeUiMock(runtime)).toEqual(runtime);
  });

  it('rewrites the runtime to a non-local preview domain in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MOCK_LIVE_PREVIEWS_REMOTE_DOMAIN', 'preview.roomote.test');

    expect(applyPreviewRuntimeUiMock(runtime)).toEqual({
      previewProxyBaseUrl: 'https://preview.roomote.test',
      previewProxyHostname: 'preview.roomote.test',
      previewDomains: ['preview.roomote.test'],
      roomotePreviewDomain: 'preview.roomote.test',
      primaryPreviewDomain: 'preview.roomote.test',
      exampleHostname: 'abc123def4567-web.preview.roomote.test',
      validation: {
        status: 'pass',
        reason: 'config_ready',
        summary:
          'Using mocked preview domain preview.roomote.test for local UI development.',
        details: [],
        checkedHostname: null,
      },
    });
  });

  it('does not apply the mock in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MOCK_LIVE_PREVIEWS_REMOTE_DOMAIN', 'preview.roomote.test');

    expect(applyPreviewRuntimeUiMock(runtime)).toEqual(runtime);
  });
});

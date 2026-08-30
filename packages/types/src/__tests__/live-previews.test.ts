import {
  analyzePreviewRuntimeConfig,
  buildExamplePreviewHostname,
  hasConfiguredPreviewPorts,
  isLocalPreviewDomain,
} from '../live-previews';

describe('live previews helpers', () => {
  it('accepts a valid preview runtime configuration', () => {
    expect(
      analyzePreviewRuntimeConfig({
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
        previewDomains: 'preview.roomote.example.com',
        roomotePreviewDomain: 'preview.roomote.example.com',
      }),
    ).toMatchObject({
      isReady: true,
      status: 'ready',
      previewProxyHostname: 'preview.roomote.example.com',
      primaryPreviewDomain: 'preview.roomote.example.com',
      issues: [],
    });
  });

  it('reports missing preview runtime config separately from invalid config', () => {
    expect(
      analyzePreviewRuntimeConfig({
        previewProxyBaseUrl: null,
        previewDomains: '',
      }).status,
    ).toBe('missing_runtime_config');

    expect(
      analyzePreviewRuntimeConfig({
        previewProxyBaseUrl: 'not-a-url',
        previewDomains: 'preview.roomote.example.com',
      }).status,
    ).toBe('validation_failed');

    expect(
      analyzePreviewRuntimeConfig({
        previewProxyBaseUrl: 'preview.roomote.example.com',
        previewDomains: 'preview.roomote.example.com',
      }).issues.map((issue) => issue.code),
    ).toContain('invalid_base_url');
  });

  it('fails when preview domains do not align', () => {
    const result = analyzePreviewRuntimeConfig({
      previewProxyBaseUrl: 'https://preview.roomote.example.com',
      previewDomains: 'other.roomote.example.com',
      roomotePreviewDomain: 'preview.roomote.example.com',
    });

    expect(result.isReady).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'base_url_domain_mismatch',
    );
  });

  it('rejects URL-form preview domain entries', () => {
    const result = analyzePreviewRuntimeConfig({
      previewProxyBaseUrl: 'https://preview.roomote.example.com',
      previewDomains:
        'https://preview.roomote.example.com,preview-alt.roomote.example.com',
      roomotePreviewDomain: 'preview.roomote.example.com',
    });

    expect(result.isReady).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'invalid_domains',
    );
  });

  it('exposes environment preview helpers', () => {
    expect(
      hasConfiguredPreviewPorts({ ports: [{ name: 'WEB', port: 3000 }] }),
    ).toBe(true);
    expect(hasConfiguredPreviewPorts({ ports: [] })).toBe(false);
    expect(buildExamplePreviewHostname('preview.roomote.example.com')).toBe(
      'abc123def4567-web.preview.roomote.example.com',
    );
    expect(buildExamplePreviewHostname('roomote.example.com', 'preview')).toBe(
      'abc123def4567-web-preview.roomote.example.com',
    );
    expect(isLocalPreviewDomain('roomotepreview.localhost')).toBe(true);
  });
});

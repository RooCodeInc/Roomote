import { NextRequest } from 'next/server';

import { GET, isAllowedCaddyPreviewDomain } from '../route';

describe('GET /api/caddy/ask', () => {
  const originalPreviewProxyBaseUrl = process.env.R_PREVIEW_PROXY_BASE_URL;
  const originalRoomotePreviewDomain = process.env.ROOMOTE_PREVIEW_DOMAIN;

  beforeEach(() => {
    process.env.R_PREVIEW_PROXY_BASE_URL = 'https://preview.roomote.test';
    delete process.env.ROOMOTE_PREVIEW_DOMAIN;
  });

  afterEach(() => {
    if (originalPreviewProxyBaseUrl === undefined) {
      delete process.env.R_PREVIEW_PROXY_BASE_URL;
    } else {
      process.env.R_PREVIEW_PROXY_BASE_URL = originalPreviewProxyBaseUrl;
    }

    if (originalRoomotePreviewDomain === undefined) {
      delete process.env.ROOMOTE_PREVIEW_DOMAIN;
    } else {
      process.env.ROOMOTE_PREVIEW_DOMAIN = originalRoomotePreviewDomain;
    }
  });

  it('allows the configured preview host and one-label preview subdomains', () => {
    expect(
      isAllowedCaddyPreviewDomain(
        'preview.roomote.test',
        'preview.roomote.test',
      ),
    ).toBe(true);
    expect(
      isAllowedCaddyPreviewDomain(
        '1npwciag739pk-web.preview.roomote.test',
        'preview.roomote.test',
      ),
    ).toBe(true);
  });

  it('denies unrelated, nested, or malformed hostnames', () => {
    expect(
      isAllowedCaddyPreviewDomain('app.roomote.test', 'preview.roomote.test'),
    ).toBe(false);
    expect(
      isAllowedCaddyPreviewDomain(
        'nested.bad.preview.roomote.test',
        'preview.roomote.test',
      ),
    ).toBe(false);
    expect(
      isAllowedCaddyPreviewDomain(
        '-bad.preview.roomote.test',
        'preview.roomote.test',
      ),
    ).toBe(false);
  });

  it('approves Caddy certificate checks for preview subdomains', async () => {
    const response = await GET(
      new NextRequest(
        'http://web:3000/api/caddy/ask?domain=1npwciag739pk-web.preview.roomote.test',
      ),
    );

    expect(response.status).toBe(200);
  });

  it('rejects Caddy certificate checks for other domains', async () => {
    const response = await GET(
      new NextRequest('http://web:3000/api/caddy/ask?domain=app.roomote.test'),
    );

    expect(response.status).toBe(403);
  });
});

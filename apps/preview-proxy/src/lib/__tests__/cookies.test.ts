vi.mock('../../services/runtime-config', () => ({
  getCachedPreviewRuntimeConfig: vi.fn(async () => ({
    effective: {
      previewProxyBaseUrl: process.env.R_PREVIEW_PROXY_BASE_URL ?? null,
    },
  })),
}));

import {
  getBaseDomain,
  getCookieDomain,
  buildSetCookieHeader,
} from '../cookies';

describe('buildSetCookieHeader', () => {
  it('builds basic cookie', () => {
    const result = buildSetCookieHeader('name', 'value', { path: '/' });
    expect(result).toBe('name=value; Path=/');
  });

  it('includes all options when provided', () => {
    const result = buildSetCookieHeader('name', 'value', {
      path: '/',
      domain: '.example.com',
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
    expect(result).toBe(
      'name=value; Path=/; Domain=.example.com; Max-Age=3600; HttpOnly; Secure; SameSite=None',
    );
  });

  it('includes Partitioned attribute when set', () => {
    const result = buildSetCookieHeader('name', 'value', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      partitioned: true,
    });
    expect(result).toContain('Partitioned');
    expect(result).toBe(
      'name=value; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
    );
  });

  it('omits Partitioned when not set', () => {
    const result = buildSetCookieHeader('name', 'value', {
      path: '/',
      sameSite: 'None',
      secure: true,
    });
    expect(result).not.toContain('Partitioned');
  });

  it('omits undefined options', () => {
    const result = buildSetCookieHeader('name', 'value', {
      path: '/',
      httpOnly: true,
    });
    expect(result).toBe('name=value; Path=/; HttpOnly');
    expect(result).not.toContain('Domain');
    expect(result).not.toContain('Secure');
    expect(result).not.toContain('SameSite');
    expect(result).not.toContain('Max-Age');
    expect(result).not.toContain('Partitioned');
  });
});

describe('getBaseDomain', () => {
  const originalEnv = process.env.R_PREVIEW_PROXY_BASE_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.R_PREVIEW_PROXY_BASE_URL = originalEnv;
    } else {
      delete process.env.R_PREVIEW_PROXY_BASE_URL;
    }
  });

  it('extracts hostname from production URL', async () => {
    process.env.R_PREVIEW_PROXY_BASE_URL = 'https://preview.roomote.example';
    await expect(getBaseDomain()).resolves.toBe('preview.roomote.example');
  });

  it('extracts hostname without port from development URL', async () => {
    process.env.R_PREVIEW_PROXY_BASE_URL =
      'http://roomotepreview.localhost:8081';
    await expect(getBaseDomain()).resolves.toBe('roomotepreview.localhost');
  });

  it('returns empty string when env var is missing', async () => {
    delete process.env.R_PREVIEW_PROXY_BASE_URL;
    await expect(getBaseDomain()).resolves.toBe('');
  });
});

describe('getCookieDomain', () => {
  const originalEnv = process.env.R_PREVIEW_PROXY_BASE_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.R_PREVIEW_PROXY_BASE_URL = originalEnv;
    } else {
      delete process.env.R_PREVIEW_PROXY_BASE_URL;
    }
  });

  it('returns dotted domain for production URL', async () => {
    process.env.R_PREVIEW_PROXY_BASE_URL = 'https://preview.roomote.example';
    await expect(getCookieDomain()).resolves.toBe('.preview.roomote.example');
  });

  it('returns undefined for localhost URL', async () => {
    process.env.R_PREVIEW_PROXY_BASE_URL =
      'http://roomotepreview.localhost:8081';
    await expect(getCookieDomain()).resolves.toBeUndefined();
  });

  it('returns undefined when env var is missing', async () => {
    delete process.env.R_PREVIEW_PROXY_BASE_URL;
    await expect(getCookieDomain()).resolves.toBeUndefined();
  });
});

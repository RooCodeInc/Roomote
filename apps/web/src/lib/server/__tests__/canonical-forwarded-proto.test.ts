import { describe, expect, it } from 'vitest';

import { withCanonicalForwardedProto } from '../canonical-forwarded-proto';

const APP_URL = 'https://roomote.example.com';

describe('withCanonicalForwardedProto', () => {
  it('forces the canonical scheme when the host matches and the proxy reported http', () => {
    const request = new Request('http://internal:13000/api/auth/session', {
      headers: {
        host: 'roomote.example.com',
        'x-forwarded-proto': 'http',
      },
    });

    const normalized = withCanonicalForwardedProto(request, APP_URL);

    expect(normalized.headers.get('x-forwarded-proto')).toBe('https');
    expect(normalized.url).toBe(request.url);
  });

  it('prefers x-forwarded-host for the canonical-host comparison', () => {
    const request = new Request('http://localhost:13000/api/auth/session', {
      headers: {
        host: 'localhost:13000',
        'x-forwarded-host': 'roomote.example.com',
        'x-forwarded-proto': 'http',
      },
    });

    const normalized = withCanonicalForwardedProto(request, APP_URL);

    expect(normalized.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('matches the first entry of a comma-separated x-forwarded-host chain', () => {
    const request = new Request('http://localhost:13000/api/auth/session', {
      headers: {
        host: 'internal-lb:8080',
        'x-forwarded-host': 'roomote.example.com, internal-lb',
        'x-forwarded-proto': 'http',
      },
    });

    const normalized = withCanonicalForwardedProto(request, APP_URL);

    expect(normalized.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('leaves requests to other hosts untouched', () => {
    const request = new Request('http://localhost:13000/api/auth/session', {
      headers: {
        host: 'localhost:13000',
        'x-forwarded-proto': 'http',
      },
    });

    const normalized = withCanonicalForwardedProto(request, APP_URL);

    expect(normalized).toBe(request);
  });

  it('returns the original request when the header already matches', () => {
    const request = new Request(
      'https://roomote.example.com/api/auth/session',
      {
        headers: {
          host: 'roomote.example.com',
          'x-forwarded-proto': 'https',
        },
      },
    );

    expect(withCanonicalForwardedProto(request, APP_URL)).toBe(request);
  });

  it('preserves the method and body of POST requests', async () => {
    const request = new Request('http://internal:13000/api/auth/oauth2/link', {
      method: 'POST',
      headers: {
        host: 'roomote.example.com',
        'content-type': 'application/json',
        'x-forwarded-proto': 'http',
      },
      body: JSON.stringify({ providerId: 'microsoft-entra-id' }),
    });

    const normalized = withCanonicalForwardedProto(request, APP_URL);

    expect(normalized.method).toBe('POST');
    expect(normalized.headers.get('x-forwarded-proto')).toBe('https');
    await expect(normalized.json()).resolves.toEqual({
      providerId: 'microsoft-entra-id',
    });
  });

  it('passes through when the canonical URL is invalid', () => {
    const request = new Request('http://localhost:13000/api/auth/session');

    expect(withCanonicalForwardedProto(request, 'not a url')).toBe(request);
  });
});

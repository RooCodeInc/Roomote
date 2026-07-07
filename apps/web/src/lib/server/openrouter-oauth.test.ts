import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  buildOpenRouterAuthorizationUrl,
  exchangeOpenRouterCodeForApiKey,
} from './openrouter-oauth';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildOpenRouterAuthorizationUrl', () => {
  it('builds the OpenRouter auth URL with an S256 challenge', () => {
    const url = new URL(
      buildOpenRouterAuthorizationUrl({
        callbackUrl:
          'https://roomote.example.com/api/openrouter-oauth/callback',
        codeChallenge: 'challenge-value',
      }),
    );

    expect(url.origin).toBe('https://openrouter.ai');
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('callback_url')).toBe(
      'https://roomote.example.com/api/openrouter-oauth/callback',
    );
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('exchangeOpenRouterCodeForApiKey', () => {
  it('posts the code and verifier and returns the API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: 'sk-or-v1-test-key' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const key = await exchangeOpenRouterCodeForApiKey({
      code: 'auth-code',
      codeVerifier: 'verifier-value',
    });

    expect(key).toBe('sk-or-v1-test-key');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/auth/keys',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    );
    expect(body).toEqual({
      code: 'auth-code',
      code_verifier: 'verifier-value',
      code_challenge_method: 'S256',
    });
  });

  it('throws when the exchange responds with an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid code' }), {
          status: 403,
        }),
      ),
    );

    await expect(
      exchangeOpenRouterCodeForApiKey({
        code: 'bad-code',
        codeVerifier: 'verifier-value',
      }),
    ).rejects.toThrow('status 403');
  });

  it('throws when the exchange returns no key', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );

    await expect(
      exchangeOpenRouterCodeForApiKey({
        code: 'auth-code',
        codeVerifier: 'verifier-value',
      }),
    ).rejects.toThrow('no API key');
  });
});

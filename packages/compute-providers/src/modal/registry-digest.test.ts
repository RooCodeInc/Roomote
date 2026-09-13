import {
  isImmutableImageTag,
  parseImageRef,
  parseWwwAuthenticate,
  pinModalBaseImageRef,
  resetModalBaseImageDigestCache,
  resolveImageRefDigest,
} from './registry-digest';

const DIGEST = `sha256:${'f'.repeat(64)}`;

function response(init: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}): Response {
  return new Response(
    init.body === undefined ? null : JSON.stringify(init.body),
    {
      status: init.status,
      headers: init.headers,
    },
  );
}

describe('parseImageRef', () => {
  it('parses registry-qualified refs with tags', () => {
    expect(parseImageRef('ghcr.io/roocodeinc/roomote-worker:develop')).toEqual({
      registry: 'ghcr.io',
      repository: 'roocodeinc/roomote-worker',
      tag: 'develop',
      digest: undefined,
    });
  });

  it('defaults the tag to latest', () => {
    expect(parseImageRef('ghcr.io/roocodeinc/roomote-worker')?.tag).toBe(
      'latest',
    );
  });

  it('keeps digests and drops the implicit tag', () => {
    expect(
      parseImageRef(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`),
    ).toEqual({
      registry: 'ghcr.io',
      repository: 'roocodeinc/roomote-worker',
      tag: undefined,
      digest: DIGEST,
    });
  });

  it('maps Docker Hub shorthand to registry-1.docker.io', () => {
    expect(parseImageRef('roomote/worker:1.0')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'roomote/worker',
      tag: '1.0',
      digest: undefined,
    });
    expect(parseImageRef('ubuntu:24.04')).toBeNull();
    expect(parseImageRef('docker.io/ubuntu:24.04')?.repository).toBe(
      'library/ubuntu',
    );
  });

  it('handles registries with ports', () => {
    expect(parseImageRef('localhost:5000/roomote-worker:local')).toEqual({
      registry: 'localhost:5000',
      repository: 'roomote-worker',
      tag: 'local',
      digest: undefined,
    });
  });

  it('rejects bare local tags and malformed digests', () => {
    expect(parseImageRef('roomote-worker:local')).toBeNull();
    expect(parseImageRef('ghcr.io/org/repo@sha256:nope')).toBeNull();
    expect(parseImageRef('')).toBeNull();
  });
});

describe('parseWwwAuthenticate', () => {
  it('parses quoted and bare parameter values', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm=https://r.example/token,service=r.example,scope="repository:a/b:pull"',
      ),
    ).toEqual([
      {
        scheme: 'bearer',
        params: {
          realm: 'https://r.example/token',
          service: 'r.example',
          scope: 'repository:a/b:pull',
        },
      },
    ]);
  });

  it('splits comma-separated challenge lists', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="https://a.example/token",service="a", Basic realm="Registry Realm"',
      ),
    ).toEqual([
      {
        scheme: 'bearer',
        params: { realm: 'https://a.example/token', service: 'a' },
      },
      { scheme: 'basic', params: { realm: 'Registry Realm' } },
    ]);
  });
});

describe('isImmutableImageTag', () => {
  it('recognizes release-pipeline tags and commit SHAs', () => {
    expect(isImmutableImageTag('develop-0a1b2c3d')).toBe(true);
    expect(isImmutableImageTag('main-0a1b2c3d')).toBe(true);
    expect(isImmutableImageTag('v1.3.0')).toBe(true);
    expect(isImmutableImageTag('v1.3.0-rc.1')).toBe(true);
    expect(isImmutableImageTag('a'.repeat(40))).toBe(true);
  });

  it('treats channel aliases and custom tags as mutable', () => {
    expect(isImmutableImageTag('develop')).toBe(false);
    expect(isImmutableImageTag('main')).toBe(false);
    expect(isImmutableImageTag('latest')).toBe(false);
    expect(isImmutableImageTag('arm64-real')).toBe(false);
    expect(isImmutableImageTag(undefined)).toBe(false);
  });
});

describe('resolveImageRefDigest', () => {
  it('follows the bearer challenge and returns the digest-pinned ref', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> =
      [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          method: init?.method ?? 'GET',
          auth: headers.get('authorization'),
        });

        if (url.startsWith('https://ghcr.io/token')) {
          return response({ status: 200, body: { token: 'registry-token' } });
        }

        if (!headers.get('authorization')?.startsWith('Bearer ')) {
          return response({
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:roocodeinc/roomote-worker:pull"',
            },
          });
        }

        return response({
          status: 200,
          headers: { 'docker-content-digest': DIGEST },
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        registryUsername: 'user',
        registryPassword: 'pass',
        fetchImpl,
      }),
    ).resolves.toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);

    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET', 'HEAD']);
    expect(calls[0]?.url).toBe(
      'https://ghcr.io/v2/roocodeinc/roomote-worker/manifests/develop',
    );
    expect(calls[0]?.auth).toBeNull();
    expect(calls[1]?.url).toBe(
      'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aroocodeinc%2Froomote-worker%3Apull',
    );
    expect(calls[1]?.auth).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
    expect(calls[2]?.auth).toBe('Bearer registry-token');
  });

  it('retries the token request anonymously when credentials are rejected', async () => {
    const tokenAuths: Array<string | null> = [];
    const tokenUrls: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);

        if (url.startsWith('https://ghcr.io/token')) {
          const auth = headers.get('authorization');
          tokenAuths.push(auth);
          tokenUrls.push(url);
          return auth
            ? response({ status: 403, body: { errors: [{ code: 'DENIED' }] } })
            : response({ status: 200, body: { token: 'anon-token' } });
        }

        if (headers.get('authorization') === 'Bearer anon-token') {
          return response({
            status: 200,
            headers: { 'docker-content-digest': DIGEST },
          });
        }

        return response({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"',
          },
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        registryUsername: 'stale-user',
        registryPassword: 'expired-token',
        fetchImpl,
      }),
    ).resolves.toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);

    expect(
      tokenUrls.every((url) =>
        url.includes('scope=repository%3Aroocodeinc%2Froomote-worker%3Apull'),
      ),
    ).toBe(true);
    expect(tokenAuths).toEqual([
      `Basic ${Buffer.from('stale-user:expired-token').toString('base64')}`,
      null,
    ]);
  });

  it('retries the manifest request with Basic credentials when the registry challenges with Basic', async () => {
    const calls: Array<{ method: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const auth = headers.get('authorization');
        calls.push({ method: init?.method ?? 'GET', auth });

        if (String(input).includes('/token')) {
          throw new Error('token endpoint must not be called for Basic');
        }

        if (auth?.startsWith('Basic ')) {
          return response({
            status: 200,
            headers: { 'docker-content-digest': DIGEST },
          });
        }

        return response({
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="Registry Realm"' },
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'registry.example.com/roomote/worker:develop',
        registryUsername: 'user',
        registryPassword: 'pass',
        fetchImpl,
      }),
    ).resolves.toBe(`registry.example.com/roomote/worker@${DIGEST}`);

    expect(calls).toEqual([
      { method: 'HEAD', auth: null },
      {
        method: 'HEAD',
        auth: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      },
    ]);
  });

  it('throws when the registry challenges with Basic and no credentials are configured', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="Registry Realm"' },
      }),
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'registry.example.com/roomote/worker:develop',
        fetchImpl,
      }),
    ).rejects.toThrow(/requires Basic credentials/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to send credentials to a token realm on another site', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('ghcr.io/token')) {
        throw new Error('credentials must not reach the foreign realm');
      }
      return response({
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
        },
      });
    }) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'mirror.example.com/roomote/worker:develop',
        registryUsername: 'user',
        registryPassword: 'pass',
        fetchImpl,
      }),
    ).rejects.toThrow(/refusing to send registry credentials/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses plaintext token realms', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="http://registry.example.com/token",service="registry.example.com"',
        },
      }),
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'registry.example.com/roomote/worker:develop',
        fetchImpl,
      }),
    ).rejects.toThrow(/refusing to request a registry token over http:/u);
  });

  it('accepts a token realm on a sibling host of the same site', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://auth.docker.io/token')) {
          return response({ status: 200, body: { token: 'hub-token' } });
        }
        if (new Headers(init?.headers).get('authorization')) {
          return response({
            status: 200,
            headers: { 'docker-content-digest': DIGEST },
          });
        }
        return response({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({ ref: 'docker.io/roomote/worker:1.0', fetchImpl }),
    ).resolves.toBe(`docker.io/roomote/worker@${DIGEST}`);
  });

  it('returns digest-pinned refs unchanged without touching the registry', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const ref = `ghcr.io/roocodeinc/roomote-worker@${DIGEST}`;

    await expect(resolveImageRefDigest({ ref, fetchImpl })).resolves.toBe(ref);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the registry does not return a digest', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      resolveImageRefDigest({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        fetchImpl,
      }),
    ).rejects.toThrow(/Docker-Content-Digest/u);
  });

  it('throws on non-registry-qualified refs', async () => {
    await expect(
      resolveImageRefDigest({ ref: 'roomote-worker:local' }),
    ).rejects.toThrow(/not registry-qualified/u);
  });
});

describe('pinModalBaseImageRef', () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
    resetModalBaseImageDigestCache({ now: () => now });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetModalBaseImageDigestCache();
    vi.restoreAllMocks();
  });

  it('pins mutable tags and caches the lookup', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        status: 200,
        headers: { 'docker-content-digest': DIGEST },
      }),
    ) as unknown as typeof fetch;

    const first = await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
    });
    const second = await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
    });

    expect(first).toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 120_000;
    await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the tag when the registry lookup fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        fetchImpl,
      }),
    ).resolves.toBe('ghcr.io/roocodeinc/roomote-worker:develop');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not resolve base image digest'),
    );
  });

  it('serves the last resolved digest when a refresh fails', async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return response({
        status: 200,
        headers: { 'docker-content-digest': DIGEST },
      });
    }) as unknown as typeof fetch;
    const pin = () =>
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        fetchImpl,
      });

    await expect(pin()).resolves.toBe(
      `ghcr.io/roocodeinc/roomote-worker@${DIGEST}`,
    );

    fail = true;
    now += 120_000;
    await expect(pin()).resolves.toBe(
      `ghcr.io/roocodeinc/roomote-worker@${DIGEST}`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('using last resolved digest'),
    );
  });

  it('caches failures briefly instead of retrying on every call', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const pin = () =>
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        fetchImpl,
      });

    await expect(pin()).resolves.toBe(
      'ghcr.io/roocodeinc/roomote-worker:develop',
    );
    await expect(pin()).resolves.toBe(
      'ghcr.io/roocodeinc/roomote-worker:develop',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 20_000;
    await pin();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('aborts the lookup with the caller signal and does not cache the abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          );
        }),
    ) as unknown as typeof fetch;

    const pending = pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBe(
      'ghcr.io/roocodeinc/roomote-worker:develop',
    );
    expect(console.warn).not.toHaveBeenCalled();

    const ok = vi.fn(async () =>
      response({
        status: 200,
        headers: { 'docker-content-digest': DIGEST },
      }),
    ) as unknown as typeof fetch;
    await expect(
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
        fetchImpl: ok,
      }),
    ).resolves.toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('skips the registry for immutable release tags', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:develop-0a1b2c3d',
        fetchImpl,
      }),
    ).resolves.toBe('ghcr.io/roocodeinc/roomote-worker:develop-0a1b2c3d');
    await expect(
      pinModalBaseImageRef({
        ref: 'ghcr.io/roocodeinc/roomote-worker:v1.3.0',
        fetchImpl,
      }),
    ).resolves.toBe('ghcr.io/roocodeinc/roomote-worker:v1.3.0');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves bare local tags and digest refs alone', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      pinModalBaseImageRef({ ref: 'roomote-worker:local', fetchImpl }),
    ).resolves.toBe('roomote-worker:local');
    await expect(
      pinModalBaseImageRef({
        ref: `ghcr.io/roocodeinc/roomote-worker@${DIGEST}`,
        fetchImpl,
      }),
    ).resolves.toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

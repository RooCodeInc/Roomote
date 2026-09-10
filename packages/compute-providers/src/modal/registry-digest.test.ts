import {
  clearModalBaseImageDigestCache,
  parseImageRef,
  pinModalBaseImageRef,
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
  beforeEach(() => {
    clearModalBaseImageDigestCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins mutable tags and caches the lookup', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        status: 200,
        headers: { 'docker-content-digest': DIGEST },
      }),
    ) as unknown as typeof fetch;
    let now = 1_000;

    const first = await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
      now: () => now,
    });
    const second = await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
      now: () => now,
    });

    expect(first).toBe(`ghcr.io/roocodeinc/roomote-worker@${DIGEST}`);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 120_000;
    await pinModalBaseImageRef({
      ref: 'ghcr.io/roocodeinc/roomote-worker:develop',
      fetchImpl,
      now: () => now,
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

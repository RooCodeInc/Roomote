import { readFileSync } from 'node:fs';
import { fetch, Agent } from 'undici';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import {
  integrationRequest,
  loadHttpIntegrationsConfig,
  type HttpIntegrationsConfig,
} from './broker';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('@roomote/sdk/server/safe-fetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/sdk/server/safe-fetch')>();
  return {
    ...actual,
    assertEgressUrlAllowed: vi.fn(actual.assertEgressUrlAllowed),
    createGuardedConnectOptions: vi.fn(actual.createGuardedConnectOptions),
  };
});
const { destroy } = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(
    class {
      destroy = destroy;
    },
  ),
}));

const entry = {
  id: 'example',
  description: 'Example API',
  origin: 'https://api.example.com',
  rules: [{ method: 'GET' as const, pathPrefix: '/v1/items' }],
  credential: {
    header: 'Authorization',
    valueEnv: 'HTTP_TEST_SECRET',
    prefix: 'Bearer ',
  },
};
const config: HttpIntegrationsConfig = {
  integrations: [entry],
};
const args = { integrationId: 'example', method: 'GET', path: '/v1/items' };
const env = {
  R_HTTP_INTEGRATIONS_CONFIG_PATH: '/manifest.json',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HTTP_TEST_SECRET', 'opaque-placeholder');
  vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true }) as never);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify([entry]));
});
afterEach(() => vi.unstubAllEnvs());

it('loads the exact manifest schema without returning config validation details', () => {
  expect(loadHttpIntegrationsConfig(env)).toEqual(config);
});

it.each(Object.keys(env))('requires %s', (key) => {
  expect(() =>
    loadHttpIntegrationsConfig({ ...env, [key]: undefined }),
  ).toThrow(`HTTP integrations requires ${key}`);
});

it.each([
  { origin: 'http://api.example.com' },
  { origin: 'https://user:password@api.example.com' },
  { origin: 'https://api.example.com/path' },
  { origin: 'https://api.example.com/?x=1' },
  { origin: 'https://api.example.com/#x' },
  { origin: 'https://api.example.com/../' },
  { id: '../bad' },
  { id: 'x'.repeat(65) },
  { rules: [] },
  { rules: [{ method: 'CONNECT', pathPrefix: '/' }] },
  { rules: [{ method: 'GET', pathPrefix: '/v1/../items' }] },
  { rules: [{ method: 'GET', pathPrefix: '/v1/items/' }] },
  { credential: { header: 'Host', valueEnv: 'SECRET' } },
  { credential: { header: 'Proxy-Authorization', valueEnv: 'SECRET' } },
  { credential: { header: 'Authorization', value: 'secret-value' } },
  ...['', '1SECRET', 'SECRET-NAME', 'SECRET\nOTHER', 'X'.repeat(129)].map(
    (valueEnv) => ({ credential: { header: 'Authorization', valueEnv } }),
  ),
  { credential: { ...entry.credential, prefix: 'Bearer\r\nx: y' } },
  { allowedUserIds: [] },
  { allowedUserIds: [''] },
  { allowedUserIds: [1] },
  { extra: 'secret-value' },
])(
  'rejects invalid manifest entries without disclosing values (%j)',
  (overrides) => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([{ ...entry, ...overrides }]),
    );
    expect(() => loadHttpIntegrationsConfig(env)).toThrow(
      'Invalid HTTP integrations configuration: check integration manifest',
    );
  },
);

it('rejects duplicate ids and malformed JSON', () => {
  for (const manifest of [JSON.stringify([entry, entry]), '{secret-value']) {
    vi.mocked(readFileSync).mockReturnValue(manifest);
    expect(() => loadHttpIntegrationsConfig(env)).toThrow(
      /^Invalid HTTP integrations configuration:/,
    );
  }
});

it.each(['/v1/items', '/v1/items/123', '/v1/items?q=two%20words'])(
  'permits bounded paths %s via a request-local guarded Agent only',
  async (path) => {
    expect(
      await integrationRequest(config, 'run:1', { ...args, path }, 'actor'),
    ).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(assertEgressUrlAllowed).toHaveBeenCalledWith(
      new URL(path, entry.origin),
    );
    expect(createGuardedConnectOptions).toHaveBeenCalledWith({
      allowedPrivateCidrs: undefined,
    });
    expect(Agent).toHaveBeenCalledWith({
      connect: vi.mocked(createGuardedConnectOptions).mock.results[0]!.value,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(path, entry.origin),
      expect.objectContaining({
        dispatcher: expect.anything(),
        redirect: 'manual',
        headers: { Authorization: 'Bearer opaque-placeholder' },
      }),
    );
    expect(destroy).toHaveBeenCalledOnce();
  },
);

it.each([
  'https://evil.example/v1/items',
  '//evil.example/v1/items',
  '/v1/items-evil',
  '/v1/items/../private',
  '/v1/items/./x',
  '/v1/items/%2e%2e/private',
  '/v1/items/%252e%252e/private',
  '/v1/items/%25252e%25252e/private',
  '/v1/items/%2fprivate',
  '/v1/items/%5cprivate',
  '/v1/items\\private',
  '/v1/items#fragment',
  '/v1/items//private',
  '/v1/items/%00',
  '/v1/items/%zz',
])(
  'rejects destination/path bypass %s before opening an Agent',
  async (path) => {
    await expect(
      integrationRequest(config, 'run:1', { ...args, path }, 'actor'),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(Agent).not.toHaveBeenCalled();
  },
);

it.each([
  { integrationId: 'unknown' },
  { method: 'DELETE' },
  { headers: { Authorization: 'secret' } },
  { body: 'x' },
  { contentType: 'application/json\r\nAuthorization: secret' },
])('rejects unauthorized or unsupported input %j', async (overrides) => {
  await expect(
    integrationRequest(config, 'run:1', { ...args, ...overrides }, 'actor'),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('permits explicitly authorized mutation but caps UTF-8 request bodies at 1 MiB', async () => {
  const mutable = {
    ...config,
    integrations: [
      {
        ...entry,
        rules: [{ method: 'POST' as const, pathPrefix: '/v1/items' }],
      },
    ],
  };
  await integrationRequest(
    mutable,
    'run:1',
    {
      ...args,
      method: 'POST',
      body: '{}',
      contentType: 'application/json',
    },
    'actor',
  );
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: 'Bearer opaque-placeholder',
        'content-type': 'application/json',
      },
    }),
  );
  vi.mocked(fetch).mockClear();
  await expect(
    integrationRequest(
      mutable,
      'run:1',
      {
        ...args,
        method: 'POST',
        body: 'é'.repeat(600_000),
      },
      'actor',
    ),
  ).rejects.toThrow('Invalid integration request');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['GET', 'HEAD'] as const)(
  'normalizes absent, null and empty %s bodies without forwarding content headers',
  async (method) => {
    const bodylessConfig = {
      integrations: [
        { ...entry, rules: [{ method, pathPrefix: '/v1/items' }] },
      ],
    };
    for (const representation of [
      { body: '' },
      {},
      { body: undefined },
      { body: null },
    ]) {
      for (const contentType of [undefined, null, 'text/plain']) {
        vi.mocked(fetch).mockResolvedValueOnce(
          (method === 'HEAD'
            ? new Response(null)
            : Response.json({ ok: true })) as never,
        );
        await integrationRequest(
          bodylessConfig,
          'run:bodyless',
          { ...args, method, ...representation, contentType },
          'actor',
        );
        const request = vi.mocked(fetch).mock.lastCall![1]!;
        expect(request).not.toHaveProperty('body');
        expect(request.headers).toEqual({
          Authorization: 'Bearer opaque-placeholder',
        });
        expect(request.redirect).toBe('manual');
        expect(request.dispatcher).toBeDefined();
      }
    }
  },
);

it.each(['GET', 'HEAD'] as const)(
  'still rejects every nonempty or nonstring %s body before transport',
  async (method) => {
    const bodylessConfig = {
      integrations: [
        { ...entry, rules: [{ method, pathPrefix: '/v1/items' }] },
      ],
    };
    for (const body of [' ', '\n', '{}', 'null', 'x', {}, [], 0, false]) {
      await expect(
        integrationRequest(
          bodylessConfig,
          'run:bodyless',
          { ...args, method, body },
          'actor',
        ),
      ).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(Agent).not.toHaveBeenCalled();
  },
);

it.each([
  { method: 'POST' },
  { path: '/private' },
  { headers: { Authorization: 'override' } },
  { contentType: '' },
])(
  'does not let empty-body normalization bypass policy: %j',
  async (overrides) => {
    await expect(
      integrationRequest(
        config,
        'run:bodyless',
        { ...args, body: '', ...overrides },
        'actor',
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(Agent).not.toHaveBeenCalled();
  },
);

it('returns only allowlisted response headers', async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json(
      {},
      {
        status: 429,
        headers: {
          'set-cookie': 'secret',
          authorization: 'secret',
          'retry-after': '30',
          'x-request-id': 'req-1',
        },
      },
    ) as never,
  );
  expect(await integrationRequest(config, 'run:1', args, 'actor')).toEqual({
    status: 429,
    body: '{}',
    headers: {
      'content-type': 'application/json',
      'retry-after': '30',
      'x-request-id': 'req-1',
    },
  });
});

it.each([
  { status: 302, headers: { location: 'https://evil.example' } },
  { status: 200, headers: { 'content-type': 'application/octet-stream' } },
  {
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'content-length': String(2 * 1024 * 1024 + 1),
    },
  },
])(
  'rejects redirects, binary and oversized declared responses, cancelling and destroying (%j)',
  async (init) => {
    const cancel = vi.fn();
    const headers = new Headers();
    for (const [key, value] of Object.entries(init.headers))
      if (value !== undefined) headers.set(key, value);
    vi.mocked(fetch).mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: init.status,
        headers,
      }) as never,
    );
    await expect(
      integrationRequest(config, 'run:1', args, 'actor'),
    ).rejects.toThrow(
      'Integration request failed: upstream unavailable or response rejected',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('caps streamed responses, cancels the reader and releases its lock', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    }),
    { headers: { 'content-type': 'text/plain' } },
  );
  vi.mocked(fetch).mockResolvedValue(response as never);
  await expect(
    integrationRequest(config, 'run:1', args, 'actor'),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
  expect(destroy).toHaveBeenCalledOnce();
});

it('does not expose upstream failures or fall back to global fetch', async () => {
  const direct = vi.spyOn(globalThis, 'fetch');
  vi.mocked(fetch).mockRejectedValue(
    new Error('Authorization: actual-secret https://sensitive.example'),
  );
  await expect(
    integrationRequest(config, 'run:1', args, 'actor'),
  ).rejects.toThrow(
    'Integration request failed: upstream unavailable or response rejected',
  );
  expect(direct).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
  direct.mockRestore();
});

it('applies a 30s timeout and caller abort, then releases concurrency slots', async () => {
  const abort = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  vi.mocked(fetch).mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      ),
  );
  const pending = integrationRequest(
    config,
    'run:abort',
    args,
    'actor',
    abort.signal,
  );
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(destroy).toHaveBeenCalledOnce();
  timeout.mockRestore();
});

it('bounds per-run and global concurrency, recovering after failures', async () => {
  const release: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Promise((_resolve, reject) =>
        release.push(() => reject(new Error('upstream failed'))),
      ),
  );
  const requests: Array<Promise<unknown>> = [];
  for (let i = 0; i < 4; i++)
    requests.push(
      integrationRequest(config, 'run:per-run', args, 'actor').catch(() => {}),
    );
  await expect(
    integrationRequest(config, 'run:per-run', args, 'actor'),
  ).rejects.toThrow('concurrency');
  release.splice(0).forEach((done) => done());
  await Promise.all(requests.splice(0));
  for (let i = 0; i < 32; i++)
    requests.push(
      integrationRequest(
        config,
        `run:${Math.floor(i / 4)}`,
        args,
        'actor',
      ).catch(() => {}),
    );
  await expect(
    integrationRequest(config, 'run:0', args, 'actor'),
  ).rejects.toThrow('concurrency');
  await expect(
    integrationRequest(config, 'run:other', args, 'actor'),
  ).rejects.toThrow('concurrency');
  release.forEach((done) => done());
  await Promise.all(requests);
  vi.mocked(fetch).mockResolvedValue(Response.json({}) as never);
  await expect(
    integrationRequest(config, 'run:0', args, 'actor'),
  ).resolves.toMatchObject({ status: 200 });
});

it('reads raw credentials per request for rotation and supports unprefixed injection', async () => {
  const raw = {
    integrations: [
      {
        ...entry,
        credential: { header: 'X-Api-Key', valueEnv: 'HTTP_TEST_SECRET' },
      },
    ],
  };
  for (const secret of ['first-raw-secret', 'rotated-raw-secret']) {
    vi.stubEnv('HTTP_TEST_SECRET', secret);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ok: true }) as never,
    );
    await integrationRequest(raw, 'run:rotation', args, 'actor');
    expect(fetch).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({ headers: { 'X-Api-Key': secret } }),
    );
  }
});

it.each([undefined, '', 'secret\r\nx: y', 'secret\tvalue', 'x'.repeat(4097)])(
  'fails closed on missing or invalid runtime credentials (%s)',
  async (value) => {
    vi.stubEnv('HTTP_TEST_SECRET', value);
    await expect(
      integrationRequest(config, 'run:secret', args, 'actor'),
    ).rejects.toThrow('Integration request failed');
    expect(fetch).not.toHaveBeenCalled();
    expect(Agent).not.toHaveBeenCalled();
  },
);

it('rejects injected header values over 4096 bytes', async () => {
  vi.stubEnv('HTTP_TEST_SECRET', 'x'.repeat(4096));
  await expect(
    integrationRequest(config, 'run:secret', args, 'actor'),
  ).rejects.toThrow('Integration request failed');
  expect(fetch).not.toHaveBeenCalled();
});

it('enforces allowed actors before constructing an Agent', async () => {
  const restricted = {
    integrations: [{ ...entry, allowedUserIds: ['allowed'] }],
  };
  await expect(
    integrationRequest(restricted, 'run:actor', args, 'other'),
  ).rejects.toThrow('Unknown integration');
  expect(fetch).not.toHaveBeenCalled();
  expect(Agent).not.toHaveBeenCalled();
  await expect(
    integrationRequest(restricted, 'run:actor', args, 'allowed'),
  ).resolves.toMatchObject({ status: 200 });
});

it.each([
  'http://api.example.com',
  'https://127.0.0.1',
  'https://169.254.169.254',
  'https://[::1]',
])('rejects SSRF origin %s without dialing', async (origin) => {
  // HTTP is rejected by the manifest. Literal private IPs are also guarded at request time.
  if (origin.startsWith('http:')) {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([{ ...entry, origin }]),
    );
    expect(() => loadHttpIntegrationsConfig(env)).toThrow(
      'Invalid HTTP integrations configuration',
    );
  } else {
    await expect(
      integrationRequest(
        { integrations: [{ ...entry, origin }] },
        'run:ssrf',
        args,
        'actor',
      ),
    ).rejects.toThrow('Integration request failed');
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(Agent).not.toHaveBeenCalled();
});

it.each(['body', 'content-type', 'retry-after', 'x-request-id'])(
  'rejects literal raw and full injected credential reflection in %s',
  async (location) => {
    for (const reflected of [
      'opaque-placeholder',
      'Bearer opaque-placeholder',
    ]) {
      const headers = {
        'content-type': 'text/plain',
        ...(location === 'body'
          ? {}
          : {
              [location]:
                location === 'content-type'
                  ? `text/plain; reflected=${reflected}`
                  : reflected,
            }),
      };
      const response = new Response(
        location === 'body' ? `before ${reflected} after` : 'safe body',
        { headers },
      );
      vi.mocked(fetch).mockResolvedValueOnce(response as never);
      await expect(
        integrationRequest(config, 'run:reflection', args, 'actor'),
      ).rejects.toThrow(
        'Integration request failed: upstream unavailable or response rejected',
      );
      expect(response.body!.locked).toBe(false);
    }
    expect(destroy).toHaveBeenCalledTimes(2);
  },
);

it('blocks reflection split across body chunks', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('opaque-'));
          c.enqueue(new TextEncoder().encode('placeholder'));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/plain' } },
    ) as never,
  );
  await expect(
    integrationRequest(config, 'run:reflection', args, 'actor'),
  ).rejects.toThrow('Integration request failed');
});

it('wires the DNS guard into the Agent and pins only vetted public answers', async () => {
  const lookup = vi.fn((_hostname, _options, callback) =>
    callback(null, [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]),
  );
  const actual = await vi.importActual<
    typeof import('@roomote/sdk/server/safe-fetch')
  >('@roomote/sdk/server/safe-fetch');
  const connect = actual.createGuardedConnectOptions({
    allowedPrivateCidrs: undefined,
    lookup: lookup as never,
  });
  vi.mocked(createGuardedConnectOptions).mockReturnValueOnce(connect);
  await integrationRequest(config, 'run:dns', args, 'actor');
  const wired = vi.mocked(Agent).mock.calls[0]![0]!.connect as typeof connect;
  const callback = vi.fn();
  wired.lookup('api.example.com', { all: true }, callback);
  expect(lookup).toHaveBeenCalledWith(
    'api.example.com',
    { all: true, verbatim: true },
    expect.any(Function),
  );
  expect(callback).toHaveBeenCalledWith(
    null,
    [{ address: '93.184.216.34', family: 4 }],
    undefined,
  );
  callback.mockClear();
  wired.lookup('api.example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  lookup.mockImplementationOnce((_hostname, _options, cb) =>
    cb(null, [{ address: '10.0.0.1', family: 4 }]),
  );
  callback.mockClear();
  wired.lookup('api.example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 4);
});

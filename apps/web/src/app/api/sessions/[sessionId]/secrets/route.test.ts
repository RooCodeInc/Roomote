import { GET, POST, DELETE } from './route';
import { filterSessionSecretTelemetry } from '@/lib/server/session-secret-telemetry';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  env: {
    R_PUBLIC_URL: 'https://roomote.example' as string | undefined,
    R_APP_URL: 'http://localhost:3000',
  },
}));
vi.mock('@/lib/server/auth-context', () => ({ authorize: mocks.authorize }));
vi.mock('@/lib/server/env', () => ({ Env: mocks.env }));
vi.mock('@roomote/sdk/server/session-secrets', () => ({
  createSessionSecret: mocks.create,
  listSessionSecretApprovals: mocks.list,
  revokeSessionSecret: mocks.revoke,
}));

const sessionId = 'e19702ce-306b-4db3-813c-77f299f1eb20';
const secretRef = '9912344c-fbef-42f1-9d24-0fc2a196001a';
const props = { params: Promise.resolve({ sessionId }) };
const plaintext = 'never-expose-this-secret';
const createArgs = {
  pendingRef: secretRef,
  secret: plaintext,
};
const metadata = { secretRef, label: 'API' };
function request(
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  return new Request(`http://internal:3000/api/sessions/${sessionId}/secrets`, {
    method,
    headers: {
      origin: 'https://roomote.example',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function expectError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'Request unavailable' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.R_PUBLIC_URL = 'https://roomote.example';
  mocks.authorize.mockResolvedValue({ success: true, userId: 'cookie-user' });
  mocks.create.mockResolvedValue(metadata);
  mocks.list.mockResolvedValue({
    pending: [{ pendingRef: secretRef, label: 'API' }],
    secrets: [metadata],
  });
});

describe('session secret route boundary', () => {
  it.each([POST, DELETE])(
    'cancels stalled bodies after one 10-second budget',
    async (handler) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel,
      });
      try {
        const req = new Request('http://internal/secrets', {
          method: 'POST',
          headers: {
            origin: 'https://roomote.example',
            'content-type': 'application/json',
          },
          body: stream,
          duplex: 'half',
        } as RequestInit);
        const response = handler(req, props);
        await vi.advanceTimersByTimeAsync(9_000);
        controller!.enqueue(new TextEncoder().encode('{'));
        await vi.advanceTimersByTimeAsync(999);
        expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expectError(await response, 408);
        expect(cancel).toHaveBeenCalledOnce();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.revoke).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each([GET, POST, DELETE])(
    'rejects unauthenticated requests',
    async (handler) => {
      mocks.authorize.mockResolvedValue({ success: false });
      await expectError(await handler(request('POST', createArgs), props), 401);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );
  it('lists metadata using only the server identity', async () => {
    const response = await GET(request('GET'), props);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pending: [{ pendingRef: secretRef, label: 'API' }],
      secrets: [metadata],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.authorize).toHaveBeenCalledWith();
    expect(mocks.list).toHaveBeenCalledWith({
      sessionId,
      userId: 'cookie-user',
    });
  });
  it('creates behind a proxy using the configured public origin', async () => {
    const response = await POST(
      request('POST', createArgs, {
        'x-forwarded-host': 'roomote.example, internal-proxy',
      }),
      props,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ secret: metadata });
    expect(mocks.create).toHaveBeenCalledWith(
      { sessionId, userId: 'cookie-user' },
      createArgs,
    );
  });
  it('revokes using the strict secret reference body', async () => {
    const response = await DELETE(request('DELETE', { secretRef }), props);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.revoke).toHaveBeenCalledWith(
      { sessionId, userId: 'cookie-user' },
      { secretRef },
    );
  });
  it.each([POST, DELETE])(
    'rejects foreign, absent, opaque, or malformed origins despite forged proxy headers',
    async (handler) => {
      for (const origin of [
        '',
        'null',
        'https://attacker.example',
        'https://roomote.example.attacker.test',
        'https://roomote.example/path',
        'https://roomote.example, https://attacker.example',
      ]) {
        await expectError(
          await handler(
            request('POST', createArgs, {
              origin,
              host: 'attacker.example',
              'x-forwarded-host': 'attacker.example',
              'x-forwarded-proto': 'https',
            }),
            props,
          ),
          403,
        );
      }
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );
  it('uses configured app origin when no public URL exists', async () => {
    mocks.env.R_PUBLIC_URL = undefined;
    expect(
      (
        await POST(
          request('POST', createArgs, { origin: 'http://localhost:3000' }),
          props,
        )
      ).status,
    ).toBe(201);
  });
  it.each([POST, DELETE])('requires JSON', async (handler) => {
    await expectError(
      await handler(
        request('POST', createArgs, { 'content-type': 'text/plain' }),
        props,
      ),
      415,
    );
  });
  it.each([POST, DELETE])(
    'bounds actual streamed UTF-8 bytes without trusting Content-Length',
    async (handler) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ secret: '😀'.repeat(6000) }),
      );
      const cancel = vi.fn();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 10000));
          controller.enqueue(bytes.slice(10000));
        },
        cancel,
      });
      const req = new Request('http://internal/secrets', {
        method: 'POST',
        headers: {
          origin: 'https://roomote.example',
          'content-type': 'application/json',
          'content-length': '1',
        },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      await expectError(await handler(req, props), 413);
      expect(cancel).toHaveBeenCalled();
    },
  );
  it('rejects caller identity, extra revoke fields, invalid references and policy overrides', async () => {
    for (const policy of [
      { label: 'Other' },
      { origin: 'https://other.example' },
      { headerName: 'authorization' },
      { headerPrefix: '' },
      { expiresAt: '2030-01-01T00:00:00Z' },
      { ttlHours: 24 },
    ]) {
      await expectError(
        await POST(request('POST', { ...createArgs, ...policy }), props),
        400,
      );
    }
    await expectError(
      await POST(request('POST', { ...createArgs, userId: 'attacker' }), props),
      400,
    );
    await expectError(
      await POST(
        request('POST', { ...createArgs, headerName: 'cookie' }),
        props,
      ),
      400,
    );
    await expectError(
      await DELETE(request('DELETE', { secretRef, userId: 'attacker' }), props),
      400,
    );
    await expectError(
      await DELETE(request('DELETE', { secretRef: 'not-uuid' }), props),
      400,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it('rejects invalid session IDs and malformed JSON without echoing content', async () => {
    await expectError(
      await GET(request('GET'), {
        params: Promise.resolve({ sessionId: plaintext }),
      }),
      400,
    );
    const req = new Request('http://internal', {
      method: 'POST',
      headers: {
        origin: 'https://roomote.example',
        'content-type': 'application/json',
      },
      body: plaintext,
    });
    await expectError(await POST(req, props), 400);
  });
  it.each([
    [GET, 'list'],
    [POST, 'create'],
    [DELETE, 'revoke'],
  ] as const)(
    'returns generic errors without logging plaintext',
    async (handler, operation) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks[operation].mockRejectedValue(new Error(plaintext));
      await expectError(
        await handler(
          request('POST', operation === 'revoke' ? { secretRef } : createArgs),
          props,
        ),
        500,
      );
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    },
  );
  it('contains authorization errors too', async () => {
    mocks.authorize.mockRejectedValue(new Error(plaintext));
    await expectError(await GET(request('GET'), props), 500);
  });
});

describe('secret route telemetry protection', () => {
  it.each([
    `https://roomote.example/api/sessions/${sessionId}/secrets?secret=${plaintext}`,
    '/api/sessions/[sessionId]/secrets',
    `/api/sessions/${sessionId}/%73ecrets`,
  ])('drops sensitive events rather than retaining copies elsewhere', (url) => {
    expect(
      filterSessionSecretTelemetry({
        request: { url, data: plaintext },
        extra: { body: plaintext },
      }),
    ).toBeNull();
    expect(
      filterSessionSecretTelemetry({ transaction: `POST ${url}` }),
    ).toBeNull();
  });
  it('preserves unrelated route telemetry', () => {
    const event = { request: { url: '/api/sessions/123/presence' } };
    expect(filterSessionSecretTelemetry(event)).toBe(event);
  });
});

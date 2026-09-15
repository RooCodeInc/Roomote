import { DELETE, GET, POST } from './route';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  env: {
    R_PUBLIC_URL: 'https://roomote.example' as string | undefined,
    R_APP_URL: 'http://localhost:3000',
  },
}));
vi.mock('@/lib/server/auth-context', () => ({ authorize: mocks.authorize }));
vi.mock('@/lib/server/env', () => ({ Env: mocks.env }));
vi.mock('@roomote/sdk/server/service-credentials', () => ({
  createIntegration: mocks.create,
  listIntegrations: mocks.list,
  revokeIntegration: mocks.revoke,
}));

const secretRef = '9912344c-fbef-42f1-9d24-0fc2a196001a';
const auth = { success: true, userId: 'cookie-user' };
const metadata = { secretRef, label: 'API', expiresAt: null };
const createArgs = {
  label: 'API',
  origin: 'https://api.example.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  secret: 'never-expose-this-secret',
};
function request(
  method: 'POST' | 'DELETE',
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request('http://internal:3000/api/account/integrations', {
    method,
    headers: {
      origin: 'https://roomote.example',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.R_PUBLIC_URL = 'https://roomote.example';
  mocks.authorize.mockResolvedValue(auth);
  mocks.list.mockResolvedValue([metadata]);
  mocks.create.mockResolvedValue(metadata);
  mocks.revoke.mockResolvedValue(undefined);
});

it("lists the signed-in user's integrations from the server identity only", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ secrets: [metadata] });
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith('cookie-user');
});

it('adds an integration with defaults applied and the key passed only to the SDK', async () => {
  const response = await POST(request('POST', createArgs));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ secret: metadata });
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith('cookie-user', {
    ...createArgs,
    allowedMethods: ['GET', 'HEAD'],
  });
});

it('revokes with the strict reference body for the signed-in user', async () => {
  const response = await DELETE(request('DELETE', { secretRef }));
  expect(response.status).toBe(204);
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('cookie-user', {
    secretRef,
  });
});

it.each([
  ['unauthenticated', request('POST', createArgs), 401, true],
  [
    'cross-origin',
    request('POST', createArgs, { origin: 'https://evil.example' }),
    403,
    false,
  ],
  [
    'wrong content type',
    request('POST', createArgs, { 'content-type': 'text/plain' }),
    415,
    false,
  ],
  [
    'caller identity',
    request('POST', { ...createArgs, userId: 'someone-else' }),
    400,
    false,
  ],
  [
    'invalid lifetime',
    request('POST', { ...createArgs, lifetimeHours: 0 }),
    400,
    false,
  ],
  ['malformed revoke', request('DELETE', { secretRef: 'nope' }), 400, false],
] as const)(
  'rejects a %s request without calling the SDK',
  async (_name, req, status, signedOut) => {
    if (signedOut) mocks.authorize.mockResolvedValue({ success: false });
    const response =
      req.method === 'POST' ? await POST(req) : await DELETE(req);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Request unavailable' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  },
);

it('contains SDK failures without echoing them', async () => {
  mocks.create.mockRejectedValue(new Error('contains-a-secret-value'));
  const response = await POST(request('POST', createArgs));
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain(
    'contains-a-secret-value',
  );
  mocks.list.mockRejectedValue(new Error('contains-a-secret-value'));
  expect((await GET()).status).toBe(500);
});

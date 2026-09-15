import { DELETE, GET } from './route';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
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
  listAccountSecrets: mocks.list,
  revokeAccountSecret: mocks.revoke,
}));

const secretRef = '9912344c-fbef-42f1-9d24-0fc2a196001a';
const auth = { success: true, userId: 'cookie-user' };
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://internal:3000/api/account/integrations', {
    method: 'DELETE',
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
  mocks.list.mockResolvedValue([{ secretRef, label: 'API', scope: 'account' }]);
  mocks.revoke.mockResolvedValue(undefined);
});

it("lists the signed-in user's saved integrations from the server identity only", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    secrets: [{ secretRef, label: 'API', scope: 'account' }],
  });
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith('cookie-user');
});

it('revokes with the strict reference body for the signed-in user', async () => {
  const response = await DELETE(request({ secretRef }));
  expect(response.status).toBe(204);
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('cookie-user', {
    secretRef,
  });
});

it.each([
  ['unauthenticated', request({ secretRef }), 401, true],
  [
    'cross-origin',
    request({ secretRef }, { origin: 'https://evil.example' }),
    403,
    false,
  ],
  [
    'wrong content type',
    request({ secretRef }, { 'content-type': 'text/plain' }),
    415,
    false,
  ],
  ['extra fields', request({ secretRef, userId: 'someone-else' }), 400, false],
  ['malformed reference', request({ secretRef: 'nope' }), 400, false],
] as const)(
  'rejects a %s revoke without calling the SDK',
  async (_name, req, status, signedOut) => {
    if (signedOut) mocks.authorize.mockResolvedValue({ success: false });
    const response = await DELETE(req);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Request unavailable' });
    expect(mocks.revoke).not.toHaveBeenCalled();
  },
);

it('contains SDK failures without echoing them', async () => {
  mocks.revoke.mockRejectedValue(new Error('contains-a-secret-value'));
  const response = await DELETE(request({ secretRef }));
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain(
    'contains-a-secret-value',
  );
  mocks.list.mockRejectedValue(new Error('contains-a-secret-value'));
  expect((await GET()).status).toBe(500);
});

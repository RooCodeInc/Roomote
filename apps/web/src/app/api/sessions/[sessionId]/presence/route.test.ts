import { NextRequest } from 'next/server';

const {
  authorizeMock,
  disconnectSessionPresenceMock,
  findAccessibleSessionMock,
  refreshSessionPresenceMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  disconnectSessionPresenceMock: vi.fn(),
  findAccessibleSessionMock: vi.fn(),
  refreshSessionPresenceMock: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('@/lib/server/sessions', () => ({
  findAccessibleSession: findAccessibleSessionMock,
}));
vi.mock('@roomote/redis', () => ({
  disconnectSessionPresence: disconnectSessionPresenceMock,
  refreshSessionPresence: refreshSessionPresenceMock,
}));

import { DELETE, POST } from './route';

const SESSION_ID = '6a1f8f1e-0000-4000-8000-000000000006';
const CLIENT_ID = '6a1f8f1e-0000-4000-8000-000000000007';
const USER_ID = '6a1f8f1e-0000-4000-8000-000000000008';

function request(method: 'POST' | 'DELETE', clientId = CLIENT_ID) {
  return new NextRequest(
    `http://localhost/api/sessions/${SESSION_ID}/presence`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    },
  );
}

const props = { params: Promise.resolve({ sessionId: SESSION_ID }) };

describe('/api/sessions/[sessionId]/presence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      success: true,
      userId: USER_ID,
      isAdmin: false,
    });
    findAccessibleSessionMock.mockResolvedValue({ id: SESSION_ID });
    refreshSessionPresenceMock.mockResolvedValue({ expiresAt: 31_000 });
  });

  it('activates presence for the authenticated user and accessible Session', async () => {
    const response = await POST(request('POST'), props);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ expiresAt: 31_000 });
    expect(refreshSessionPresenceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: USER_ID,
      clientId: CLIENT_ID,
    });
  });

  it('disconnects the authenticated tab lease', async () => {
    const response = await DELETE(request('DELETE'), props);

    expect(response.status).toBe(204);
    expect(disconnectSessionPresenceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userId: USER_ID,
      clientId: CLIENT_ID,
    });
  });

  it('rejects unauthenticated requests', async () => {
    authorizeMock.mockResolvedValue({ success: false });

    const response = await POST(request('POST'), props);

    expect(response.status).toBe(401);
    expect(findAccessibleSessionMock).not.toHaveBeenCalled();
    expect(refreshSessionPresenceMock).not.toHaveBeenCalled();
  });

  it('does not create presence for an inaccessible Session', async () => {
    findAccessibleSessionMock.mockResolvedValue(null);

    const response = await POST(request('POST'), props);

    expect(response.status).toBe(404);
    expect(refreshSessionPresenceMock).not.toHaveBeenCalled();
  });

  it('rejects malformed client identifiers', async () => {
    const response = await POST(request('POST', 'not-a-uuid'), props);

    expect(response.status).toBe(400);
    expect(findAccessibleSessionMock).not.toHaveBeenCalled();
  });
});

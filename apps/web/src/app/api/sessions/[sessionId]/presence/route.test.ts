import { NextRequest } from 'next/server';
import { db, users, inArray, userFactory } from '@roomote/db/server';

const {
  authorizeMock,
  disconnectSessionPresenceMock,
  findAccessibleSessionMock,
  findReadableSessionMock,
  refreshSessionPresenceMock,
  listSessionPresentUserIdsMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  disconnectSessionPresenceMock: vi.fn(),
  findAccessibleSessionMock: vi.fn(),
  findReadableSessionMock: vi.fn(),
  refreshSessionPresenceMock: vi.fn(),
  listSessionPresentUserIdsMock: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('@/lib/server/sessions', () => ({
  findAccessibleSession: findAccessibleSessionMock,
  findReadableSession: findReadableSessionMock,
}));
vi.mock('@roomote/redis', () => ({
  disconnectSessionPresence: disconnectSessionPresenceMock,
  refreshSessionPresence: refreshSessionPresenceMock,
  listSessionPresentUserIds: listSessionPresentUserIdsMock,
}));

import { DELETE, GET, POST } from './route';

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
  const userIds: string[] = [];
  afterEach(async () => {
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
      userIds.length = 0;
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      success: true,
      userId: USER_ID,
      isAdmin: false,
    });
    findAccessibleSessionMock.mockResolvedValue({ id: SESSION_ID });
    findReadableSessionMock.mockResolvedValue({ id: SESSION_ID });
    refreshSessionPresenceMock.mockResolvedValue({ expiresAt: 31_000 });
    listSessionPresentUserIdsMock.mockResolvedValue([]);
  });

  it('returns only active viewer profiles from database users and omits missing users', async () => {
    const viewer = await userFactory.create({
      name: 'Presence Viewer',
      imageUrl: 'https://example.com/avatar.png',
    });
    const inactive = await userFactory.create();
    userIds.push(viewer.id, inactive.id);
    listSessionPresentUserIdsMock.mockResolvedValue([
      viewer.id,
      crypto.randomUUID(),
    ]);
    const response = await GET(
      new NextRequest(`http://localhost/api/sessions/${SESSION_ID}/presence`),
      props,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(findReadableSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      SESSION_ID,
    );
    expect(listSessionPresentUserIdsMock).toHaveBeenCalledWith(SESSION_ID);
    await expect(response.json()).resolves.toEqual([
      {
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        imageUrl: viewer.imageUrl,
      },
    ]);
  });

  it('returns an empty array when no viewers are active', async () => {
    const response = await GET(new NextRequest('http://localhost'), props);
    await expect(response.json()).resolves.toEqual([]);
  });

  it.each([401, 404, 400])(
    'rejects GET with %s before reading presence',
    async (status) => {
      if (status === 401) authorizeMock.mockResolvedValue({ success: false });
      if (status === 404) findReadableSessionMock.mockResolvedValue(null);
      const response = await GET(
        new NextRequest('http://localhost'),
        status === 400
          ? { params: Promise.resolve({ sessionId: 'invalid' }) }
          : props,
      );
      expect(response.status).toBe(status);
      expect(listSessionPresentUserIdsMock).not.toHaveBeenCalled();
      if (status !== 404)
        expect(findReadableSessionMock).not.toHaveBeenCalled();
    },
  );

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

  it('allows direct-link reads without granting presence writes', async () => {
    findAccessibleSessionMock.mockResolvedValue(null);
    expect((await GET(new NextRequest('http://localhost'), props)).status).toBe(
      200,
    );
    expect((await POST(request('POST'), props)).status).toBe(404);
    expect((await DELETE(request('DELETE'), props)).status).toBe(404);
    expect(refreshSessionPresenceMock).not.toHaveBeenCalled();
    expect(disconnectSessionPresenceMock).not.toHaveBeenCalled();
  });

  it('rejects malformed client identifiers', async () => {
    const response = await POST(request('POST', 'not-a-uuid'), props);

    expect(response.status).toBe(400);
    expect(refreshSessionPresenceMock).not.toHaveBeenCalled();
  });
});

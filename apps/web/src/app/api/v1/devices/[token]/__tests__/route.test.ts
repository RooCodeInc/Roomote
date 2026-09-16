import { NextRequest } from 'next/server';

const authorizeMock = vi.fn();
const insertValuesMock = vi.fn();
const onConflictMock = vi.fn();
const deleteWhereMock = vi.fn();

vi.mock('@/lib/server/auth-context', () => ({
  authorize: () => authorizeMock(),
}));

vi.mock('@roomote/db/server', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  userDevices: {
    platform: 'platform',
    token: 'token',
    userId: 'userId',
  },
  db: {
    insert: () => ({
      values: (values: unknown) => {
        insertValuesMock(values);
        return {
          onConflictDoUpdate: (conflict: unknown) => {
            onConflictMock(conflict);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({
      where: (predicate: unknown) => {
        deleteWhereMock(predicate);
        return Promise.resolve();
      },
    }),
  },
}));

import { DELETE, PUT } from '../route';

const TOKEN = 'ABCDEF0123456789abcdef0123456789';

function context(token = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

function putRequest(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/devices/${TOKEN}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/v1/devices/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
  });

  it('rejects unauthenticated callers', async () => {
    authorizeMock.mockResolvedValue({ success: false, error: 'Unauthorized' });

    const response = await PUT(
      putRequest({
        platform: 'ios',
        environment: 'sandbox',
        bundleId: 'com.example.roomote',
      }),
      context(),
    );

    expect(response.status).toBe(401);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('upserts the device for the caller and re-enables it', async () => {
    const response = await PUT(
      putRequest({
        platform: 'ios',
        environment: 'production',
        bundleId: 'com.example.roomote',
        appVersion: '1.0 (3)',
        deviceName: 'iPhone',
        categories: {
          user_input: true,
          capability_offer: false,
          task_settled: true,
          reply: true,
        },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        platform: 'ios',
        token: TOKEN.toLowerCase(),
        environment: 'production',
        bundleId: 'com.example.roomote',
        appVersion: '1.0 (3)',
        deviceName: 'iPhone',
        categories: expect.objectContaining({ capability_offer: false }),
        disabledAt: null,
        lastSeenAt: expect.any(Date),
      }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ['platform', 'token'],
        set: expect.objectContaining({ userId: 'user-1', disabledAt: null }),
      }),
    );
  });

  it('validates the token and the body', async () => {
    const badToken = await PUT(
      putRequest({
        platform: 'ios',
        environment: 'sandbox',
        bundleId: 'com.example.roomote',
      }),
      context('not-hex!'),
    );
    expect(badToken.status).toBe(400);

    const badBody = await PUT(
      putRequest({ platform: 'android', environment: 'sandbox' }),
      context(),
    );
    expect(badBody.status).toBe(400);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/devices/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
  });

  it('removes only the caller-owned row', async () => {
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/devices/${TOKEN}`, {
        method: 'DELETE',
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(deleteWhereMock).toHaveBeenCalledWith({
      and: [
        { eq: ['token', TOKEN.toLowerCase()] },
        { eq: ['userId', 'user-1'] },
      ],
    });
  });
});

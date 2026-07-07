import { NextRequest } from 'next/server';

const authorizeMock = vi.fn();
const putAvatarObjectMock = vi.fn();
const deleteAvatarObjectIfExistsMock = vi.fn();
const transactionMock = vi.fn();

const selectMock = vi.fn();

function realParseAvatarFilenameFromUrl(
  imageUrl: string,
  userId: string,
): string | null {
  const prefix = `/api/avatars/${encodeURIComponent(userId)}/`;
  if (!imageUrl.startsWith(prefix)) return null;
  const filename = imageUrl.slice(prefix.length).split('?')[0] ?? '';
  return /^avatar-\d+\.(png|jpg|webp|gif)$/.test(filename) ? filename : null;
}

vi.mock('@/lib/server/auth-context', () => ({
  authorize: () => authorizeMock(),
}));

vi.mock('@/lib/server/avatar-storage', () => ({
  buildAvatarFilename: () => 'avatar-1783449999999.png',
  buildAvatarUrl: (userId: string, _filename: string) =>
    `/api/avatars/${userId}/avatar-1783449999999.png`,
  deleteAvatarObjectIfExists: (...args: unknown[]) =>
    deleteAvatarObjectIfExistsMock(...args),
  isAllowedAvatarContentType: (contentType: string) =>
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      contentType,
    ),
  isAllowedAvatarSize: (size: number) => size > 0 && size <= 2 * 1024 * 1024,
  parseAvatarFilenameFromUrl: (imageUrl: string, userId: string) =>
    realParseAvatarFilenameFromUrl(imageUrl, userId),
  putAvatarObject: (...args: unknown[]) => putAvatarObjectMock(...args),
}));

vi.mock('@roomote/db/server', () => ({
  authUsers: { id: 'id' },
  users: { id: 'id', imageUrl: 'imageUrl' },
  eq: vi.fn(),
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectMock() }) }),
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}));

import { POST, DELETE } from '../route';

function buildPostRequest(file: File | null): NextRequest {
  const formData = new FormData();

  if (file) {
    formData.append('file', file);
  }

  return new NextRequest('http://localhost/api/user/avatar', {
    method: 'POST',
    body: formData,
  });
}

function buildDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/user/avatar', {
    method: 'DELETE',
  });
}

function makeFile(bytes: number[], type: string, name = 'avatar.png'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

// The transaction callback runs both column updates. Each test sets up
// transactionMock to either await the callback (success) or throw (failure).
function mockTransactionSuccess() {
  transactionMock.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      await cb(tx);
    },
  );
}

function mockTransactionFailure() {
  transactionMock.mockRejectedValue(new Error('DB down'));
}

describe('POST /api/user/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockResolvedValue([{ imageUrl: '' }]);
    putAvatarObjectMock.mockResolvedValue(undefined);
    deleteAvatarObjectIfExistsMock.mockResolvedValue(undefined);
    mockTransactionSuccess();
  });

  it('rejects unauthenticated requests', async () => {
    authorizeMock.mockResolvedValue({ success: false });

    const response = await POST(buildPostRequest(makeFile([1], 'image/png')));

    expect(response.status).toBe(401);
    expect(putAvatarObjectMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported image content types', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });

    const response = await POST(
      buildPostRequest(makeFile([1], 'image/svg+xml')),
    );

    expect(response.status).toBe(415);
    expect(putAvatarObjectMock).not.toHaveBeenCalled();
  });

  it('rejects images larger than 2 MB', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });

    const oversized = new Array(2 * 1024 * 1024 + 1).fill(0);
    const response = await POST(
      buildPostRequest(makeFile(oversized, 'image/png')),
    );

    expect(response.status).toBe(413);
    expect(putAvatarObjectMock).not.toHaveBeenCalled();
  });

  it('uploads, persists the URL atomically, and returns it', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });

    const response = await POST(
      buildPostRequest(makeFile([1, 2, 3], 'image/png')),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      imageUrl: '/api/avatars/user-1/avatar-1783449999999.png',
    });
    expect(putAvatarObjectMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when storage fails', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    putAvatarObjectMock.mockRejectedValue(new Error('S3 down'));

    const response = await POST(buildPostRequest(makeFile([1], 'image/png')));

    expect(response.status).toBe(502);
  });

  it('cleans up the orphaned S3 object when the DB transaction fails', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    mockTransactionFailure();

    const response = await POST(buildPostRequest(makeFile([1], 'image/png')));

    expect(response.status).toBe(500);
    expect(deleteAvatarObjectIfExistsMock).toHaveBeenCalledWith(
      'user-1',
      'avatar-1783449999999.png',
    );
  });

  it('deletes the previous uploaded avatar after a successful re-upload', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    selectMock.mockResolvedValue([
      { imageUrl: '/api/avatars/user-1/avatar-1000000000000.png' },
    ]);

    const response = await POST(buildPostRequest(makeFile([1], 'image/png')));

    expect(response.status).toBe(200);
    expect(deleteAvatarObjectIfExistsMock).toHaveBeenCalledWith(
      'user-1',
      'avatar-1000000000000.png',
    );
  });
});

describe('DELETE /api/user/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putAvatarObjectMock.mockResolvedValue(undefined);
    deleteAvatarObjectIfExistsMock.mockResolvedValue(undefined);
    mockTransactionSuccess();
  });

  it('rejects unauthenticated requests', async () => {
    authorizeMock.mockResolvedValue({ success: false });

    const response = await DELETE(buildDeleteRequest());

    expect(response.status).toBe(401);
    expect(deleteAvatarObjectIfExistsMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no uploaded avatar exists (OAuth avatar left alone)', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    selectMock.mockResolvedValue([
      { imageUrl: 'https://avatars.slack-edge.com/img.png' },
    ]);

    const response = await DELETE(buildDeleteRequest());

    expect(response.status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteAvatarObjectIfExistsMock).not.toHaveBeenCalled();
  });

  it('clears both columns and deletes the object when an uploaded avatar exists', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    selectMock.mockResolvedValue([
      { imageUrl: '/api/avatars/user-1/avatar-1000000000000.png' },
    ]);

    const response = await DELETE(buildDeleteRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(deleteAvatarObjectIfExistsMock).toHaveBeenCalledWith(
      'user-1',
      'avatar-1000000000000.png',
    );
  });

  it('returns 500 when the DB transaction fails', async () => {
    authorizeMock.mockResolvedValue({ success: true, userId: 'user-1' });
    selectMock.mockResolvedValue([
      { imageUrl: '/api/avatars/user-1/avatar-1000000000000.png' },
    ]);
    mockTransactionFailure();

    const response = await DELETE(buildDeleteRequest());

    expect(response.status).toBe(500);
    expect(deleteAvatarObjectIfExistsMock).not.toHaveBeenCalled();
  });
});

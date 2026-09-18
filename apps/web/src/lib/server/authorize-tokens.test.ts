import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFindUser, mockValidateRunToken } = vi.hoisted(() => ({
  mockFindUser: vi.fn(),
  mockValidateRunToken: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  validateAuthToken: vi.fn(),
  validateRunToken: (...args: unknown[]) => mockValidateRunToken(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => mockFindUser(...args),
      },
    },
  },
  eq: vi.fn(),
  users: { id: 'users.id' },
}));

vi.mock('./auth-context', () => ({
  authorize: vi.fn(),
}));

import { authorizeRunToken } from './authorize-tokens';

describe('authorizeRunToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a run token issued for a removed user', async () => {
    mockValidateRunToken.mockResolvedValue({
      runId: 42,
      userId: 'removed-user',
    });
    mockFindUser.mockResolvedValue({
      name: 'Removed User',
      email: 'removed@example.com',
      deletedAt: new Date(),
    });

    const result = await authorizeRunToken(
      new NextRequest('http://localhost/api/artifacts/artifact-id', {
        headers: { authorization: 'Bearer run-token' },
      }),
    );

    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: User has been removed',
    });
  });

  it('rejects a run token when its user no longer exists', async () => {
    mockValidateRunToken.mockResolvedValue({
      runId: 42,
      userId: 'missing-user',
    });
    mockFindUser.mockResolvedValue(undefined);

    const result = await authorizeRunToken(
      new NextRequest('http://localhost/api/artifacts/artifact-id', {
        headers: { authorization: 'Bearer run-token' },
      }),
    );

    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: User has been removed',
    });
  });

  it('continues to authorize deployment-principal run tokens', async () => {
    mockValidateRunToken.mockResolvedValue({ runId: 42 });

    const result = await authorizeRunToken(
      new NextRequest('http://localhost/api/artifacts/artifact-id', {
        headers: { authorization: 'Bearer run-token' },
      }),
    );

    expect(result).toMatchObject({
      success: true,
      userType: 'run',
      runId: 42,
      name: 'Unknown',
      primaryEmail: '',
      isAdmin: false,
    });
    expect(mockFindUser).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindFirst, mockAnd, mockEq, mockInArray } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockAnd: vi.fn((...conditions: unknown[]) => ({ conditions })),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockInArray: vi.fn((column: unknown, values: unknown[]) => ({
    column,
    values,
  })),
}));

vi.mock('@roomote/db/server', () => ({
  and: mockAnd,
  eq: mockEq,
  inArray: mockInArray,
  isNull: vi.fn(),
  db: {
    query: {
      repositories: { findFirst: mockFindFirst },
      githubInstallations: { findFirst: vi.fn() },
      mcpConnections: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
    },
  },
  githubInstallations: { suspendedAt: 'suspendedAt' },
  mcpConnections: {
    mcpId: 'mcpId',
    enabled: 'enabled',
    authStatus: 'authStatus',
    userId: 'userId',
  },
  repositories: {
    isActive: 'isActive',
    sourceControlProvider: 'sourceControlProvider',
  },
  slackInstallations: { isActive: 'isActive' },
}));

import { hasActiveRepository } from '../automation-requirements';

describe('hasActiveRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ id: 'repo-1' });
  });

  it('accepts any active provider when no capability filter is supplied', async () => {
    await expect(hasActiveRepository()).resolves.toBe(true);

    expect(mockInArray).not.toHaveBeenCalled();
  });

  it('filters by the automation supported source-control providers', async () => {
    await expect(
      hasActiveRepository(['github', 'gitlab', 'gitea']),
    ).resolves.toBe(true);

    expect(mockInArray).toHaveBeenCalledWith('sourceControlProvider', [
      'github',
      'gitlab',
      'gitea',
    ]);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        conditions: [
          { column: 'isActive', value: true },
          {
            column: 'sourceControlProvider',
            values: ['github', 'gitlab', 'gitea'],
          },
        ],
      },
      columns: { id: true },
    });
  });

  it('fails closed when a capability descriptor has no providers', async () => {
    await expect(hasActiveRepository([])).resolves.toBe(false);

    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbSelectMock, leftJoinMock, whereMock, limitMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  leftJoinMock: vi.fn(),
  whereMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  db: {
    select: dbSelectMock,
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  slackUserMappings: {
    id: 'id',
    slackUserId: 'slackUserId',
    slackTeamId: 'slackTeamId',
    userId: 'userId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  users: {
    id: 'users.id',
    deletedAt: 'users.deletedAt',
    metadata: 'users.metadata',
  },
}));

describe('lookupSlackUserMapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockReset();
    whereMock.mockReturnValue({ limit: limitMock });
    leftJoinMock.mockReturnValue({ where: whereMock });
    dbSelectMock.mockReturnValue({
      from: vi.fn(() => ({ leftJoin: leftJoinMock })),
    });
  });

  it('returns the active mapping when the linked user is still active', async () => {
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const updatedAt = new Date('2024-01-02T00:00:00.000Z');
    limitMock.mockResolvedValueOnce([
      {
        id: 'mapping-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        userId: 'user-1',
        createdAt,
        updatedAt,
        matchedUserId: 'user-1',
        userDeletedAt: null,
        userMetadata: { communications_fast_mode_default: true },
      },
    ]);

    const { lookupSlackUserMapping } = await import('./user-mapping.js');

    await expect(
      lookupSlackUserMapping({ slackUserId: 'U123', teamId: 'T123' }),
    ).resolves.toEqual({
      activeMapping: {
        id: 'mapping-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        userId: 'user-1',
        createdAt,
        updatedAt,
        communicationsFastModeDefault: true,
      },
      hasInactiveMapping: false,
    });
  });

  it('enables Fast mode by default for active mappings without a preference', async () => {
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const updatedAt = new Date('2024-01-02T00:00:00.000Z');
    limitMock.mockResolvedValueOnce([
      {
        id: 'mapping-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        userId: 'user-1',
        createdAt,
        updatedAt,
        matchedUserId: 'user-1',
        userDeletedAt: null,
        userMetadata: {},
      },
    ]);

    const { lookupSlackUserMapping } = await import('./user-mapping.js');

    await expect(
      lookupSlackUserMapping({ slackUserId: 'U123', teamId: 'T123' }),
    ).resolves.toMatchObject({
      activeMapping: { communicationsFastModeDefault: true },
      hasInactiveMapping: false,
    });
  });

  it('flags stale mappings whose linked user was removed', async () => {
    limitMock.mockResolvedValueOnce([
      {
        id: 'mapping-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        userId: 'user-1',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-02T00:00:00.000Z'),
        matchedUserId: 'user-1',
        userDeletedAt: new Date('2024-02-01T00:00:00.000Z'),
        userMetadata: {},
      },
    ]);

    const { lookupSlackUserMapping } = await import('./user-mapping.js');

    await expect(
      lookupSlackUserMapping({ slackUserId: 'U123', teamId: 'T123' }),
    ).resolves.toEqual({
      activeMapping: null,
      hasInactiveMapping: true,
    });
  });
});

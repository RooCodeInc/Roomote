const {
  mockPostgres,
  mockReserve,
  mockReservedSql,
  mockUnsafe,
  mockRelease,
  mockEnd,
} = vi.hoisted(() => ({
  mockPostgres: vi.fn(),
  mockReserve: vi.fn(),
  mockReservedSql: vi.fn(),
  mockUnsafe: vi.fn(),
  mockRelease: vi.fn(),
  mockEnd: vi.fn(),
}));

vi.mock('postgres', () => ({ default: mockPostgres }));

import { setupTestDatabaseLifecycle } from './test-database-lifecycle';

describe('setupTestDatabaseLifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    Object.assign(mockReservedSql, {
      unsafe: mockUnsafe,
      release: mockRelease,
    });
    mockReservedSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ table_name: 'users' }])
      .mockResolvedValueOnce([{ table_name: 'users' }])
      .mockResolvedValueOnce([]);
    mockUnsafe.mockResolvedValue([]);
    mockReserve.mockResolvedValue(mockReservedSql);
    mockEnd.mockResolvedValue(undefined);
    mockPostgres.mockReturnValue({ reserve: mockReserve, end: mockEnd });
  });

  it('holds one reserved-session lock through setup and teardown', async () => {
    const teardown = await setupTestDatabaseLifecycle(
      'postgres://postgres@localhost:5432/roomote_lifecycle_test',
    );

    expect(mockReservedSql).toHaveBeenCalledTimes(2);
    expect(mockUnsafe).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();

    await teardown();

    expect(mockReservedSql).toHaveBeenCalledTimes(4);
    expect(mockUnsafe).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);

    expect(mockReservedSql.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUnsafe.mock.invocationCallOrder[0]!,
    );
    expect(mockUnsafe.mock.invocationCallOrder[1]!).toBeLessThan(
      mockReservedSql.mock.invocationCallOrder[3]!,
    );
  });

  it('shares one lifecycle across same-process Vitest projects', async () => {
    const databaseUrl =
      'postgres://postgres@localhost:5432/roomote_lifecycle_test';
    const [teardownFirstProject, teardownSecondProject] = await Promise.all([
      setupTestDatabaseLifecycle(databaseUrl),
      setupTestDatabaseLifecycle(databaseUrl),
    ]);

    expect(mockPostgres).toHaveBeenCalledTimes(1);
    expect(mockReservedSql).toHaveBeenCalledTimes(2);

    await teardownFirstProject();

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();

    await teardownSecondProject();

    expect(mockReservedSql).toHaveBeenCalledTimes(4);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and client when setup truncation fails', async () => {
    const setupError = new Error('setup truncate failed');
    mockUnsafe.mockRejectedValueOnce(setupError);

    await expect(
      setupTestDatabaseLifecycle(
        'postgres://postgres@localhost:5432/roomote_lifecycle_test',
      ),
    ).rejects.toBe(setupError);

    expect(mockReservedSql).toHaveBeenCalledTimes(3);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and client when teardown truncation fails', async () => {
    const teardownError = new Error('teardown truncate failed');
    mockUnsafe.mockResolvedValueOnce([]).mockRejectedValueOnce(teardownError);

    const teardown = await setupTestDatabaseLifecycle(
      'postgres://postgres@localhost:5432/roomote_lifecycle_test',
    );

    await expect(teardown()).rejects.toBe(teardownError);

    expect(mockReservedSql).toHaveBeenCalledTimes(4);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('closes the client when explicit unlock fails', async () => {
    const unlockError = new Error('unlock failed');
    mockReservedSql
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ table_name: 'users' }])
      .mockResolvedValueOnce([{ table_name: 'users' }])
      .mockRejectedValueOnce(unlockError);

    const teardown = await setupTestDatabaseLifecycle(
      'postgres://postgres@localhost:5432/roomote_lifecycle_test',
    );

    await expect(teardown()).rejects.toBe(unlockError);

    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('closes the client when releasing the reserved connection fails', async () => {
    const releaseError = new Error('release failed');
    mockRelease.mockImplementationOnce(() => {
      throw releaseError;
    });

    const teardown = await setupTestDatabaseLifecycle(
      'postgres://postgres@localhost:5432/roomote_lifecycle_test',
    );

    await expect(teardown()).rejects.toBe(releaseError);

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});

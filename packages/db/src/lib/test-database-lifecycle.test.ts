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

  it('shares ownership across independently evaluated setup modules', async () => {
    vi.resetModules();
    const otherModule = await import('./test-database-lifecycle');
    expect(otherModule.setupTestDatabaseLifecycle).not.toBe(
      setupTestDatabaseLifecycle,
    );
    const url =
      'postgres://postgres@localhost:5432/roomote_separate_modules_test';
    const releaseFirst = await setupTestDatabaseLifecycle(url);
    const releaseSecond = await otherModule.setupTestDatabaseLifecycle(url);

    await releaseFirst();
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockUnsafe).toHaveBeenCalledTimes(1);

    await releaseSecond();
    await releaseSecond();
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockUnsafe).toHaveBeenCalledTimes(2);
  });

  it('propagates shared setup failure to every independently loaded participant', async () => {
    vi.resetModules();
    const otherModule = await import('./test-database-lifecycle');
    const setupError = new Error('shared setup failed');
    mockUnsafe.mockRejectedValueOnce(setupError);
    const url =
      'postgres://postgres@localhost:5432/roomote_shared_failure_test';
    const results = await Promise.allSettled([
      setupTestDatabaseLifecycle(url),
      otherModule.setupTestDatabaseLifecycle(url),
    ]);
    expect(results).toEqual([
      { status: 'rejected', reason: setupError },
      { status: 'rejected', reason: setupError },
    ]);
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('does not let a new setup join a lifecycle that is already tearing down', async () => {
    mockReservedSql
      .mockReset()
      .mockImplementation(async (query: TemplateStringsArray) =>
        query.join('').includes('information_schema')
          ? [{ table_name: 'users' }]
          : [],
      );
    let finishTeardown!: () => void;
    const teardownPromise = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    mockUnsafe.mockResolvedValueOnce([]).mockReturnValueOnce(teardownPromise);
    const url =
      'postgres://postgres@localhost:5432/roomote_teardown_overlap_test';
    const releaseOld = await setupTestDatabaseLifecycle(url);
    const closing = releaseOld();
    await vi.waitFor(() => expect(mockUnsafe).toHaveBeenCalledTimes(2));
    const releaseNew = await setupTestDatabaseLifecycle(url);
    expect(mockPostgres).toHaveBeenCalledTimes(2);
    finishTeardown();
    await closing;
    const releaseJoined = await setupTestDatabaseLifecycle(url);
    expect(mockPostgres).toHaveBeenCalledTimes(2);
    await releaseNew();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    await releaseJoined();
    expect(mockEnd).toHaveBeenCalledTimes(2);
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

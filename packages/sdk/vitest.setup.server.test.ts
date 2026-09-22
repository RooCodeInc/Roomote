const { mockSetupTestDatabaseLifecycle, mockTeardownTestDatabaseLifecycle } =
  vi.hoisted(() => ({
    mockSetupTestDatabaseLifecycle: vi.fn(),
    mockTeardownTestDatabaseLifecycle: vi.fn(),
  }));

vi.mock('@roomote/db/test-database-lifecycle', () => ({
  setupTestDatabaseLifecycle: (...args: unknown[]) =>
    mockSetupTestDatabaseLifecycle(...args),
}));

describe('sdk vitest database setup', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.DATABASE_URL =
      'postgres://postgres:password@localhost:5432/roomote_sdk_test';

    mockSetupTestDatabaseLifecycle.mockResolvedValue(
      mockTeardownTestDatabaseLifecycle,
    );
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('uses the shared database lifecycle for DATABASE_URL', async () => {
    const { default: setup } = await import('./vitest.setup.server');

    const teardown = await setup();

    expect(mockSetupTestDatabaseLifecycle).toHaveBeenCalledWith(
      'postgres://postgres:password@localhost:5432/roomote_sdk_test',
    );
    expect(teardown).toBe(mockTeardownTestDatabaseLifecycle);

    await teardown();

    expect(mockTeardownTestDatabaseLifecycle).toHaveBeenCalledTimes(1);
  });
});

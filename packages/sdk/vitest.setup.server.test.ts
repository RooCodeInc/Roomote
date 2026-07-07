const {
  mockAssertSafeTestDatabaseUrl,
  mockPostgres,
  mockDrizzle,
  mockExecute,
  mockPgClient,
} = vi.hoisted(() => ({
  mockAssertSafeTestDatabaseUrl: vi.fn(),
  mockPostgres: vi.fn(),
  mockDrizzle: vi.fn(),
  mockExecute: vi.fn(),
  mockPgClient: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@roomote/db/server', () => ({
  assertSafeTestDatabaseUrl: (...args: unknown[]) =>
    mockAssertSafeTestDatabaseUrl(...args),
  postgres: (...args: unknown[]) => mockPostgres(...args),
  drizzle: (...args: unknown[]) => mockDrizzle(...args),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
    {
      raw: (value: string) => value,
    },
  ),
}));

describe('sdk vitest database setup', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.DATABASE_URL =
      'postgres://postgres:password@localhost:5432/roomote_sdk_test';

    mockPostgres.mockReturnValue(mockPgClient);
    mockDrizzle.mockReturnValue({
      execute: mockExecute.mockResolvedValue([{ table_name: 'users' }]),
    });
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('validates DATABASE_URL before opening the truncation client', async () => {
    const { default: setup } = await import('./vitest.setup.server');

    const teardown = await setup();

    expect(mockAssertSafeTestDatabaseUrl).toHaveBeenCalledWith(
      'postgres://postgres:password@localhost:5432/roomote_sdk_test',
      'test',
    );
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://postgres:password@localhost:5432/roomote_sdk_test',
      {
        prepare: false,
        onnotice: expect.any(Function),
      },
    );

    const guardCallOrder =
      mockAssertSafeTestDatabaseUrl.mock.invocationCallOrder.at(0);
    const postgresCallOrder = mockPostgres.mock.invocationCallOrder.at(0);

    expect(guardCallOrder).toBeTypeOf('number');
    expect(postgresCallOrder).toBeTypeOf('number');
    expect(guardCallOrder!).toBeLessThan(postgresCallOrder!);

    await teardown();

    expect(mockPgClient.end).toHaveBeenCalledTimes(1);
  });
});

const { mockBootstrapWebRuntimeEnv, mockFindFirst } = vi.hoisted(() => ({
  mockBootstrapWebRuntimeEnv: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock('../bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: mockFindFirst,
      },
    },
  },
  deploymentSettings: {
    id: 'id',
  },
  eq: vi.fn(),
}));

describe('isSetupBootstrapOpen', () => {
  const originalNextPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NEXT_PHASE;
  });

  afterAll(() => {
    if (originalNextPhase === undefined) {
      delete process.env.NEXT_PHASE;
    } else {
      process.env.NEXT_PHASE = originalNextPhase;
    }
  });

  it('returns false during the Next production build without querying the db', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';

    const { isSetupBootstrapOpen } = await import('../setup-bootstrap');

    await expect(isSetupBootstrapOpen()).resolves.toBe(false);
    expect(mockBootstrapWebRuntimeEnv).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('bootstraps the web runtime before querying setup state', async () => {
    mockFindFirst.mockResolvedValue({ setupCompletedAt: null });

    const { isSetupBootstrapOpen } = await import('../setup-bootstrap');

    await expect(isSetupBootstrapOpen()).resolves.toBe(true);
    expect(mockBootstrapWebRuntimeEnv).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });
});

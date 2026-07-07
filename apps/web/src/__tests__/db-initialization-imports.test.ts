describe('server module imports before db initialization', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;
  const originalNextPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.NEXT_PHASE;
  });

  afterAll(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }

    if (originalNextPhase === undefined) {
      delete process.env.NEXT_PHASE;
    } else {
      process.env.NEXT_PHASE = originalNextPhase;
    }
  });

  it('imports task helpers without touching the db singleton', async () => {
    await expect(import('../lib/server/tasks')).resolves.toBeDefined();
  }, 15000);

  it('imports task filter commands without touching the db singleton', async () => {
    await expect(
      import('../trpc/commands/filters/index'),
    ).resolves.toBeDefined();
  }, 15000);
});

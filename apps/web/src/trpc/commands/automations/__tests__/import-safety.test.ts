describe('background agent command module import safety', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_RUNTIME = 'nodejs';
  });

  afterAll(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }
  });

  it('does not access the web runtime env during module evaluation', async () => {
    await expect(import('../index')).resolves.toMatchObject({
      getBackgroundAgentSettingsCommand: expect.any(Function),
      updateBackgroundAgentSettingsCommand: expect.any(Function),
    });
  }, 15000);
});

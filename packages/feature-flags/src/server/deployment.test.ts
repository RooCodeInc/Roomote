const { findDeploymentSettings } = vi.hoisted(() => ({
  findDeploymentSettings: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: findDeploymentSettings },
    },
  },
  deploymentSettings: { id: 'id' },
  eq: vi.fn(),
}));

describe('evaluateDeploymentFeatureFlag', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    findDeploymentSettings.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses deployment metadata until the bounded cache expires', async () => {
    findDeploymentSettings
      .mockResolvedValueOnce({ metadata: { sessions_data: true } })
      .mockResolvedValueOnce({ metadata: { sessions_data: false } });

    const { evaluateDeploymentFeatureFlag } = await import('./deployment');

    await expect(evaluateDeploymentFeatureFlag('sessions_data')).resolves.toBe(
      true,
    );
    await expect(evaluateDeploymentFeatureFlag('sessions_data')).resolves.toBe(
      true,
    );
    expect(findDeploymentSettings).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);

    await expect(evaluateDeploymentFeatureFlag('sessions_data')).resolves.toBe(
      false,
    );
    expect(findDeploymentSettings).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent metadata reads', async () => {
    findDeploymentSettings.mockResolvedValue({
      metadata: { sessions_data: true, sessions_comms: true },
    });

    const { evaluateDeploymentFeatureFlag } = await import('./deployment');

    await expect(
      Promise.all([
        evaluateDeploymentFeatureFlag('sessions_data'),
        evaluateDeploymentFeatureFlag('sessions_comms'),
      ]),
    ).resolves.toEqual([true, true]);
    expect(findDeploymentSettings).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately after explicit invalidation', async () => {
    findDeploymentSettings
      .mockResolvedValueOnce({ metadata: { sessions_data: false } })
      .mockResolvedValueOnce({ metadata: { sessions_data: true } });

    const {
      evaluateDeploymentFeatureFlag,
      invalidateDeploymentFeatureFlagCache,
    } = await import('./deployment');

    await expect(evaluateDeploymentFeatureFlag('sessions_data')).resolves.toBe(
      false,
    );
    invalidateDeploymentFeatureFlagCache();
    await expect(evaluateDeploymentFeatureFlag('sessions_data')).resolves.toBe(
      true,
    );

    expect(findDeploymentSettings).toHaveBeenCalledTimes(2);
  });
});

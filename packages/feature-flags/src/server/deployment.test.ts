import type { FeatureFlag } from '../types';

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

// The production flag config is empty; the deployment evaluator machinery is
// exercised against a synthetic flag config instead.
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  FEATURE_FLAG_CONFIG: {
    synthetic_flag: { defaultValue: false },
    other_flag: { defaultValue: false },
  },
}));

const SYNTHETIC_FLAG = 'synthetic_flag' as unknown as FeatureFlag;
const OTHER_FLAG = 'other_flag' as unknown as FeatureFlag;

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
      .mockResolvedValueOnce({ metadata: { synthetic_flag: true } })
      .mockResolvedValueOnce({ metadata: { synthetic_flag: false } });

    const { evaluateDeploymentFeatureFlag } = await import('./deployment');

    await expect(evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG)).resolves.toBe(
      true,
    );
    await expect(evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG)).resolves.toBe(
      true,
    );
    expect(findDeploymentSettings).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);

    await expect(evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG)).resolves.toBe(
      false,
    );
    expect(findDeploymentSettings).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent metadata reads', async () => {
    findDeploymentSettings.mockResolvedValue({
      metadata: { synthetic_flag: true, other_flag: true },
    });

    const { evaluateDeploymentFeatureFlag } = await import('./deployment');

    await expect(
      Promise.all([
        evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG),
        evaluateDeploymentFeatureFlag(OTHER_FLAG),
      ]),
    ).resolves.toEqual([true, true]);
    expect(findDeploymentSettings).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately after explicit invalidation', async () => {
    findDeploymentSettings
      .mockResolvedValueOnce({ metadata: { synthetic_flag: false } })
      .mockResolvedValueOnce({ metadata: { synthetic_flag: true } });

    const {
      evaluateDeploymentFeatureFlag,
      invalidateDeploymentFeatureFlagCache,
    } = await import('./deployment');

    await expect(evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG)).resolves.toBe(
      false,
    );
    invalidateDeploymentFeatureFlagCache();
    await expect(evaluateDeploymentFeatureFlag(SYNTHETIC_FLAG)).resolves.toBe(
      true,
    );

    expect(findDeploymentSettings).toHaveBeenCalledTimes(2);
  });
});

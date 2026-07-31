const { mockEvaluateFeatureFlag } = vi.hoisted(() => ({
  mockEvaluateFeatureFlag: vi.fn(),
}));

vi.mock('@roomote/feature-flags/server', () => ({
  FeatureFlag: {
    BackgroundSubagents: 'BackgroundSubagents',
  },
  getFeatureFlagEvaluator: vi.fn(() => ({
    evaluate: mockEvaluateFeatureFlag,
  })),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ mocked: true })),
}));

import { FeatureFlag } from '@roomote/feature-flags';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import { featureFlagsRouter } from './feature-flags';

function createAuthCaller() {
  const auth: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  return featureFlagsRouter.createCaller({ auth });
}

function createJobCaller() {
  const auth: RunTokenContext = {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  return featureFlagsRouter.createCaller({ auth });
}

describe('featureFlagsRouter.evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateFeatureFlag.mockResolvedValue(false);
  });

  it('evaluates deployment flags for auth-token callers', async () => {
    mockEvaluateFeatureFlag.mockResolvedValue(true);

    await expect(
      createAuthCaller().evaluate({
        flag: FeatureFlag.BackgroundSubagents,
      }),
    ).resolves.toBe(true);

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith(
      'BackgroundSubagents',
      {
        isDeploymentContext: true,
      },
    );
  });

  it('evaluates deployment flags for run-token callers', async () => {
    await expect(
      createJobCaller().evaluate({
        flag: FeatureFlag.BackgroundSubagents,
      }),
    ).resolves.toBe(false);

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith(
      'BackgroundSubagents',
      {
        isDeploymentContext: true,
      },
    );
  });
});

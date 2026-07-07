const { mockEvaluateFeatureFlag } = vi.hoisted(() => ({
  mockEvaluateFeatureFlag: vi.fn(),
}));

vi.mock('@roomote/feature-flags/server', () => ({
  FeatureFlag: {
    SlackProofAutoPost: 'SlackProofAutoPost',
  },
  getFeatureFlagEvaluator: vi.fn(() => ({
    evaluate: mockEvaluateFeatureFlag,
  })),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ mocked: true })),
}));

import { FeatureFlag } from '@roomote/feature-flags';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

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
  const auth: JobTokenContext = {
    cloudJobId: 42,
    userId: 'user-1',
    tokenType: 'cj',
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
        flag: FeatureFlag.SlackProofAutoPost,
      }),
    ).resolves.toBe(true);

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith('SlackProofAutoPost', {
      isDeploymentContext: true,
    });
  });

  it('evaluates deployment flags for job-token callers', async () => {
    await expect(
      createJobCaller().evaluate({
        flag: FeatureFlag.SlackProofAutoPost,
      }),
    ).resolves.toBe(false);

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith('SlackProofAutoPost', {
      isDeploymentContext: true,
    });
  });
});

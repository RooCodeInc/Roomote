import { describe, expect, it, vi } from 'vitest';
import type { AuthTokenContext } from '@roomote/types';

vi.mock('@roomote/feature-flags/server', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@roomote/feature-flags/server')>();
  return {
    ...original,
    getFeatureFlagEvaluator: vi.fn(() => ({ evaluate: vi.fn() })),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ mocked: true })),
}));

import { featureFlagsRouter } from './feature-flags';

const auth: AuthTokenContext = {
  userId: 'user-1',
  tokenType: 'auth',
  version: 1,
};

describe('featureFlagsRouter.evaluate', () => {
  it('rejects every stale runtime feature flag', async () => {
    const caller = featureFlagsRouter.createCaller({ auth });

    await expect(
      caller.evaluate({ flag: 'SuggestionRouting' as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

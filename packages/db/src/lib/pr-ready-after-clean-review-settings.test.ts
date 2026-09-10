import type { DatabaseOrTransaction } from '../db';
import {
  getDeploymentMarkRoomotePrReadyAfterCleanReview,
  setDeploymentMarkRoomotePrReadyAfterCleanReview,
} from './pr-ready-after-clean-review-settings';

function executorWithMetadata(metadata: Record<string, unknown> | null) {
  return {
    query: {
      deploymentSettings: {
        findFirst: vi.fn().mockResolvedValue(metadata ? { metadata } : null),
      },
    },
  } as unknown as DatabaseOrTransaction;
}

describe('getDeploymentMarkRoomotePrReadyAfterCleanReview', () => {
  it('defaults to disabled when the setting is absent', async () => {
    await expect(
      getDeploymentMarkRoomotePrReadyAfterCleanReview({
        executor: executorWithMetadata(null),
      }),
    ).resolves.toBe(false);
  });

  it('returns a persisted opt-in', async () => {
    await expect(
      getDeploymentMarkRoomotePrReadyAfterCleanReview({
        executor: executorWithMetadata({
          mark_roomote_pr_ready_after_clean_review: true,
        }),
      }),
    ).resolves.toBe(true);
  });

  it('returns a persisted opt-out', async () => {
    await expect(
      getDeploymentMarkRoomotePrReadyAfterCleanReview({
        executor: executorWithMetadata({
          mark_roomote_pr_ready_after_clean_review: false,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('ignores invalid persisted values', async () => {
    await expect(
      getDeploymentMarkRoomotePrReadyAfterCleanReview({
        executor: executorWithMetadata({
          mark_roomote_pr_ready_after_clean_review: 'true',
        }),
      }),
    ).resolves.toBe(false);
  });
});

describe('setDeploymentMarkRoomotePrReadyAfterCleanReview', () => {
  it('persists and returns the explicit value', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    await expect(
      setDeploymentMarkRoomotePrReadyAfterCleanReview(true, {
        executor: { update } as unknown as DatabaseOrTransaction,
      }),
    ).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.anything(),
        updatedAt: expect.any(Date),
      }),
    );
    expect(where).toHaveBeenCalledOnce();
  });
});

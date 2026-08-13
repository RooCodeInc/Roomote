const mockRepair = vi.fn();

vi.mock('@roomote/sdk/server', () => ({
  repairOrphanPrReviewAssociationReplays: (...args: unknown[]) =>
    mockRepair(...args),
}));

import { prReviewAssociationRepairJob } from './pr-review-association-repair';

describe('prReviewAssociationRepairJob', () => {
  it('runs bounded orphan replay repair', async () => {
    mockRepair.mockResolvedValue(undefined);

    await prReviewAssociationRepairJob();

    expect(mockRepair).toHaveBeenCalledTimes(1);
  });
});

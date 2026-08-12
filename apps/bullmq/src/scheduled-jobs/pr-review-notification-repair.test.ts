const mockRepairPendingPrReviewNotificationJobs = vi.fn();

vi.mock('@roomote/sdk/server', () => ({
  repairPendingPrReviewNotificationJobs: () =>
    mockRepairPendingPrReviewNotificationJobs(),
}));

import { prReviewNotificationRepairJob } from './pr-review-notification-repair';

describe('prReviewNotificationRepairJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepairPendingPrReviewNotificationJobs.mockResolvedValue(undefined);
  });

  it('repairs pending review notifications through the shared coordinator', async () => {
    await prReviewNotificationRepairJob();

    expect(mockRepairPendingPrReviewNotificationJobs).toHaveBeenCalledOnce();
  });
});

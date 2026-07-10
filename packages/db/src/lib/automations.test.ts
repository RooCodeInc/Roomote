import { DEFAULT_PR_REVIEW_SETTINGS } from '@roomote/types';

import { normalizeReviewCodeAutomationSettings } from './automations';

describe('normalizeReviewCodeAutomationSettings', () => {
  it('defaults all-author automatic review off', () => {
    const settings = normalizeReviewCodeAutomationSettings(undefined);

    expect(settings.reviewAllPullRequestAuthors).toBe(
      DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors,
    );
  });

  it('reads all-author automatic review from the review_code settings', () => {
    const settings = normalizeReviewCodeAutomationSettings({
      enabled: true,
      settings: {
        reviewAllPullRequestAuthors: true,
      },
      targets: [],
    } as unknown as Parameters<
      typeof normalizeReviewCodeAutomationSettings
    >[0]);

    expect(settings.reviewAllPullRequestAuthors).toBe(true);
  });
});

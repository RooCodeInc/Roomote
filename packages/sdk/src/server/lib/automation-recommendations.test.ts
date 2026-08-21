import { canRecoverAutomationRecommendationInitialRunClaim } from './automation-recommendation-initial-runs';

describe('canRecoverAutomationRecommendationInitialRunClaim', () => {
  const now = Date.parse('2026-08-14T18:00:00.000Z');

  it('recovers an expired claim before dispatch starts', () => {
    expect(
      canRecoverAutomationRecommendationInitialRunClaim(
        {
          initialRunClaimedAt: '2026-08-14T17:44:59.999Z',
          initialRunDispatchAttemptedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it('keeps a fresh or dispatch-started claim exclusive', () => {
    expect(
      canRecoverAutomationRecommendationInitialRunClaim(
        {
          initialRunClaimedAt: '2026-08-14T17:45:00.001Z',
          initialRunDispatchAttemptedAt: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      canRecoverAutomationRecommendationInitialRunClaim(
        {
          initialRunClaimedAt: '2026-08-14T17:00:00.000Z',
          initialRunDispatchAttemptedAt: '2026-08-14T17:00:01.000Z',
        },
        now,
      ),
    ).toBe(false);
  });
});

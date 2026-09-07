import {
  buildAutomationRecommendationFingerprint,
  canRecoverAutomationRecommendationInitialRunClaim,
} from './automation-recommendations';

describe('buildAutomationRecommendationFingerprint', () => {
  it('invalidates a cached Slack target when its workspace binding changes', () => {
    const target = {
      provider: 'slack' as const,
      targetKind: 'slack_channel' as const,
      externalRef: 'C123',
    };
    expect(
      buildAutomationRecommendationFingerprint(['repo'], 'github', {
        ...target,
        metadata: { slackTeamId: 'T1' },
      }),
    ).not.toBe(
      buildAutomationRecommendationFingerprint(['repo'], 'github', {
        ...target,
        metadata: { slackTeamId: 'T2' },
      }),
    );
  });
  it('invalidates cached recommendations when the configured destination changes', () => {
    const withoutDelivery = buildAutomationRecommendationFingerprint(
      ['repo'],
      'github',
    );
    const target = {
      provider: 'slack' as const,
      targetKind: 'slack_channel' as const,
      externalRef: 'C123',
    };
    expect(
      buildAutomationRecommendationFingerprint(['repo'], 'github', target),
    ).not.toBe(withoutDelivery);
    expect(
      buildAutomationRecommendationFingerprint(['repo'], 'github', {
        ...target,
        externalRef: 'C456',
      }),
    ).not.toBe(
      buildAutomationRecommendationFingerprint(['repo'], 'github', target),
    );
  });

  it('does not invalidate the batch for refreshed routing metadata', () => {
    const target = {
      provider: 'teams' as const,
      targetKind: 'teams_channel' as const,
      externalRef: 'conversation',
    };
    expect(
      buildAutomationRecommendationFingerprint(['repo'], 'github', target),
    ).toBe(
      buildAutomationRecommendationFingerprint(['repo'], 'github', {
        ...target,
        metadata: { serviceUrl: 'https://route.test' },
      }),
    );
  });
});

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

import {
  getBackgroundAgentFrequencyValues,
  getCommunicationAutomationTargetKind,
  hasEnabledBackgroundAgents,
  isCommunicationAutomationTarget,
  isProviderUsageLimitThreshold,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_IDS,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
} from '../background-agents';

describe('background agent helpers', () => {
  it('returns all frequency values from the settings object', () => {
    expect(
      getBackgroundAgentFrequencyValues({
        conflictResolverFrequency: 'off',
        suggesterFrequency: 'daily',
        announcerFrequency: 'weekly',
        conflictResolverLabel: 'Roomote',
      }),
    ).toEqual(['off', 'daily', 'weekly']);
  });

  it('returns false when every background agent is off', () => {
    expect(
      hasEnabledBackgroundAgents({
        conflictResolverFrequency: 'off',
        suggesterFrequency: 'off',
        announcerFrequency: 'off',
      }),
    ).toBe(false);
  });

  it('returns true when any current background agent is enabled', () => {
    expect(
      hasEnabledBackgroundAgents({
        conflictResolverFrequency: 'every_6_hours',
        suggesterFrequency: 'off',
        announcerFrequency: 'off',
      }),
    ).toBe(true);
  });

  it('returns true for future background agent frequency fields too', () => {
    expect(
      hasEnabledBackgroundAgents({
        conflictResolverFrequency: 'off',
        suggesterFrequency: 'off',
        announcerFrequency: 'off',
        triageFrequency: 'daily',
      }),
    ).toBe(true);
  });

  it('returns true when channel auto-start is enabled', () => {
    expect(
      hasEnabledBackgroundAgents({
        conflictResolverFrequency: 'off',
        suggesterFrequency: 'off',
        announcerFrequency: 'off',
        channelAutoStartEnabled: true,
      }),
    ).toBe(true);
  });

  it('derives schedule-only automation ids and fields from metadata', () => {
    expect(SCHEDULE_ONLY_BACKGROUND_AUTOMATION_IDS).toEqual(
      SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map(
        (automation) => automation.id,
      ),
    );
    expect(
      SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map(
        (automation) => automation.frequencyField,
      ),
    ).toEqual([
      'securityAuditorFrequency',
      'codeQualityAuditorFrequency',
      'ciFailureTriageFrequency',
      'issueFixerFrequency',
    ]);
  });

  it('accepts only supported provider usage threshold slider values', () => {
    expect(isProviderUsageLimitThreshold(5)).toBe(true);
    expect(isProviderUsageLimitThreshold(50)).toBe(true);
    expect(isProviderUsageLimitThreshold(85)).toBe(true);
    expect(isProviderUsageLimitThreshold(95)).toBe(true);
    expect(isProviderUsageLimitThreshold(4)).toBe(false);
    expect(isProviderUsageLimitThreshold(81)).toBe(false);
    expect(isProviderUsageLimitThreshold(100)).toBe(false);
  });

  it.each([
    ['slack', 'slack_channel', 'slack_user'],
    ['discord', 'discord_channel', 'discord_user'],
    ['teams', 'teams_channel', 'teams_user'],
    ['telegram', 'telegram_chat', 'telegram_user'],
  ] as const)(
    'keeps channel and direct-message target kinds aligned for %s',
    (provider, channelKind, userKind) => {
      expect(getCommunicationAutomationTargetKind(provider, 'channel')).toBe(
        channelKind,
      );
      expect(
        getCommunicationAutomationTargetKind(provider, 'direct_message'),
      ).toBe(userKind);
      expect(
        isCommunicationAutomationTarget({
          provider,
          targetKind: channelKind,
        }),
      ).toBe(true);
      expect(
        isCommunicationAutomationTarget({ provider, targetKind: userKind }),
      ).toBe(true);
    },
  );
});

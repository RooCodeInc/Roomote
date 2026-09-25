import {
  getAutomationTargetKind,
  getCommunicationAutomationTargetKind,
  hasEnabledBackgroundAgents,
  isAutomationDestinationTarget,
  isCommunicationAutomationTarget,
  isProviderUsageLimitThreshold,
} from '../background-agents';

describe('background agent helpers', () => {
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

  it('accepts only supported provider usage threshold slider values', () => {
    expect(isProviderUsageLimitThreshold(5)).toBe(true);
    expect(isProviderUsageLimitThreshold(50)).toBe(true);
    expect(isProviderUsageLimitThreshold(85)).toBe(true);
    expect(isProviderUsageLimitThreshold(95)).toBe(true);
    expect(isProviderUsageLimitThreshold(4)).toBe(false);
    expect(isProviderUsageLimitThreshold(81)).toBe(false);
    expect(isProviderUsageLimitThreshold(100)).toBe(false);
  });

  it('keeps channel and direct-message target kinds aligned for every provider', () => {
    for (const [provider, channelKind, userKind] of [
      ['slack', 'slack_channel', 'slack_user'],
      ['discord', 'discord_channel', 'discord_user'],
      ['teams', 'teams_channel', 'teams_user'],
      ['telegram', 'telegram_chat', 'telegram_user'],
    ] as const) {
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
    }
  });

  it('supports account Email as a direct-message-only automation target', () => {
    expect(getAutomationTargetKind('email', 'direct_message')).toBe(
      'email_user',
    );
    expect(() => getAutomationTargetKind('email', 'channel')).toThrow(
      'Email automation destinations must use direct message mode.',
    );
    expect(
      isAutomationDestinationTarget({
        provider: 'email',
        targetKind: 'email_user',
      }),
    ).toBe(true);
    expect(
      isCommunicationAutomationTarget({
        provider: 'email',
        targetKind: 'email_user',
      }),
    ).toBe(false);
  });
});

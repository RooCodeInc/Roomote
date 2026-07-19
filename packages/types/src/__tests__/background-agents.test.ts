import {
  getBackgroundAgentFrequencyValues,
  hasEnabledBackgroundAgents,
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
});

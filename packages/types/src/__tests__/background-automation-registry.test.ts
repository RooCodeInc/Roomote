import {
  getBackgroundAutomationSettingsDescriptor,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  getTriggerableBackgroundAutomationSettingsHash,
  getTriggerableBackgroundAutomationDescriptor,
  SHARED_MANAGER_CHANNEL_ONLY_KINDS,
  isSharedManagerChannelOnlyKind,
} from '../background-automation-registry';

describe('background automation registry', () => {
  it('keeps manual trigger identities aligned with automation keys', () => {
    const codeQualityAuditor =
      getTriggerableBackgroundAutomationDescriptor('codeQualityAuditor');

    expect(codeQualityAuditor).toMatchObject({
      automationKey: 'code_quality_auditor',
      schedule: {
        field: 'codeQualityAuditorFrequency',
      },
      manualTrigger: {
        jobName: 'CodeQualityAuditor',
      },
      managerChannelKind: 'codeQualityAuditor',
    });
  });

  it('resolves scheduled suggestion metadata from the shared descriptor', () => {
    const descriptor = getScheduledSuggestionBackgroundAutomationDescriptor(
      'code_quality_auditor',
    );

    expect(descriptor?.agentId).toBe('codeQualityAuditor');
    expect(
      descriptor && 'scheduledSuggestionSource' in descriptor
        ? descriptor.scheduledSuggestionSource
        : null,
    ).toBe('code_quality_auditor');
    expect(
      descriptor
        ? getTriggerableBackgroundAutomationSettingsHash(descriptor.agentId)
        : null,
    ).toBe('code-quality-auditor');
  });

  it('defaults unknown scheduled suggestion sources to Suggest Ideas', () => {
    const descriptor = getScheduledSuggestionBackgroundAutomationDescriptor();

    expect(descriptor?.agentId).toBe('suggester');
    expect(
      descriptor && 'scheduledSuggestionSource' in descriptor
        ? descriptor.scheduledSuggestionSource
        : null,
    ).toBe('suggest_ideas');
    expect(
      descriptor
        ? getTriggerableBackgroundAutomationSettingsHash(descriptor.agentId)
        : null,
    ).toBe('suggest-ideas');
  });

  it('tracks shared-only manager channel kinds through the registry', () => {
    expect(SHARED_MANAGER_CHANNEL_ONLY_KINDS).toEqual([
      'managerStats',
      'sentryTriage',
      'dependabotTriage',
      'securityAuditor',
      'codeQualityAuditor',
      'ciFailureTriage',
    ]);
    expect(isSharedManagerChannelOnlyKind('suggester')).toBe(false);
    expect(isSharedManagerChannelOnlyKind('announcer')).toBe(false);
  });

  it('derives automation settings labels from the shared settings catalog', () => {
    expect(
      getBackgroundAutomationSettingsDescriptor('code-quality-auditor'),
    ).toEqual({
      hash: 'code-quality-auditor',
      label: 'Code Quality Auditor',
      agentId: 'codeQualityAuditor',
    });
    expect(
      getBackgroundAutomationSettingsDescriptor('suggest-self-improvements'),
    ).toEqual({
      hash: 'suggest-self-improvements',
      label: 'Suggest Self-improvements',
    });
  });
});

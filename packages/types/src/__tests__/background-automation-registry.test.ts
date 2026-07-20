import {
  getBackgroundAutomationSettingsDescriptor,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  getTriggerableBackgroundAutomationDescriptorByKey,
  getTriggerableBackgroundAutomationSettingsHash,
  isTriggerableBackgroundAutomationKey,
} from '../background-automation-registry';

describe('background automation registry', () => {
  it('keys descriptors by the canonical snake_case automation key', () => {
    const codeQualityAuditor =
      getTriggerableBackgroundAutomationDescriptorByKey('code_quality_auditor');

    expect(codeQualityAuditor).toMatchObject({
      automationKey: 'code_quality_auditor',
      label: 'Code Quality Auditor',
      usesManagerChannel: true,
    });
    expect(isTriggerableBackgroundAutomationKey('code_quality_auditor')).toBe(
      true,
    );
    expect(isTriggerableBackgroundAutomationKey('codeQualityAuditor')).toBe(
      false,
    );
  });

  it('resolves scheduled suggestion metadata from the shared descriptor', () => {
    const descriptor = getScheduledSuggestionBackgroundAutomationDescriptor(
      'code_quality_auditor',
    );

    expect(descriptor?.automationKey).toBe('code_quality_auditor');
    expect(
      descriptor && 'scheduledSuggestionSource' in descriptor
        ? descriptor.scheduledSuggestionSource
        : null,
    ).toBe('code_quality_auditor');
    expect(
      descriptor
        ? getTriggerableBackgroundAutomationSettingsHash(
            descriptor.automationKey,
          )
        : null,
    ).toBe('code-quality-auditor');
  });

  it('defaults unknown scheduled suggestion sources to Suggest Ideas', () => {
    const descriptor = getScheduledSuggestionBackgroundAutomationDescriptor();

    expect(descriptor?.automationKey).toBe('suggester');
    expect(
      descriptor && 'scheduledSuggestionSource' in descriptor
        ? descriptor.scheduledSuggestionSource
        : null,
    ).toBe('suggest_ideas');
    expect(
      descriptor
        ? getTriggerableBackgroundAutomationSettingsHash(
            descriptor.automationKey,
          )
        : null,
    ).toBe('suggest-ideas');
  });

  it('derives automation settings labels from the shared settings catalog', () => {
    expect(
      getBackgroundAutomationSettingsDescriptor('code-quality-auditor'),
    ).toEqual({
      hash: 'code-quality-auditor',
      label: 'Code Quality Auditor',
      automationKey: 'code_quality_auditor',
    });
    expect(
      getBackgroundAutomationSettingsDescriptor('roomote-managers'),
    ).toEqual({
      hash: 'roomote-managers',
      label: 'Manager Channel',
    });
  });

  it('allows Slack, Discord, and Telegram destinations for the suggester', () => {
    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('suggester');

    expect(descriptor?.supportedCommunicationProviders).toEqual([
      'slack',
      'discord',
      'telegram',
    ]);
  });

  it('allows Teams, Telegram, and Discord destinations for CI failure triage Run now', () => {
    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage');

    expect(descriptor?.supportedCommunicationProviders).toEqual([
      'slack',
      'teams',
      'telegram',
      'discord',
    ]);
    expect(descriptor?.supportedSourceControlProviders).toEqual(['github']);
  });
});

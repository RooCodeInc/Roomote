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

  it('allows all communication destinations for the suggester', () => {
    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('suggester');

    expect(descriptor?.supportedCommunicationProviders).toEqual([
      'slack',
      'teams',
      'telegram',
      'discord',
    ]);
  });

  it('registers provider usage alerts as a cross-provider deterministic automation', () => {
    const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
      'provider_usage_limit',
    );

    expect(descriptor).toMatchObject({
      label: 'Inference Provider Usage Alerts',
      slackIcon: 'battery-warning',
      scheduleModes: ['off', 'every_hour'],
      usesManagerChannel: true,
      supportedCommunicationProviders: [
        'slack',
        'teams',
        'telegram',
        'discord',
      ],
      supportedSourceControlProviders: [],
    });
    expect(
      getTriggerableBackgroundAutomationSettingsHash('provider_usage_limit'),
    ).toBe('provider-usage-limit');
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
    expect(descriptor?.supportedSourceControlProviders).toEqual([
      'github',
      'gitlab',
      'ado',
      'bitbucket',
      'gitea',
    ]);
  });

  it('supports GitHub, GitLab, and Gitea for issue triage', () => {
    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('issue_fixer');

    expect(descriptor?.label).toBe('Triage Issues');
    expect(descriptor?.supportedSourceControlProviders).toEqual([
      'github',
      'gitlab',
      'gitea',
    ]);
  });

  it('supports Gitea conflict scans alongside GitHub, GitLab, and Azure DevOps', () => {
    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('conflict_resolver');

    expect(descriptor?.supportedSourceControlProviders).toEqual([
      'github',
      'gitlab',
      'ado',
      'gitea',
    ]);
  });

  it('classifies every triggerable automation that launches sandbox tasks', () => {
    expect(
      (
        [
          'conflict_resolver',
          'suggester',
          'announcer',
          'manager_stats',
          'provider_usage_limit',
          'sentry_triage',
          'dependabot_triage',
          'codeql_triage',
          'issue_fixer',
          'security_auditor',
          'code_quality_auditor',
          'ci_failure_triage',
        ] as const
      ).map((key) => [
        key,
        getTriggerableBackgroundAutomationDescriptorByKey(key)
          ?.taskLaunchPolicyId,
      ]),
    ).toEqual([
      ['conflict_resolver', 'conflict_resolution'],
      ['suggester', 'suggester_scan'],
      ['announcer', 'announcer'],
      ['manager_stats', null],
      ['provider_usage_limit', null],
      ['sentry_triage', 'scheduled_triage_scan'],
      ['dependabot_triage', 'scheduled_triage_scan'],
      ['codeql_triage', 'scheduled_triage_scan'],
      ['issue_fixer', 'issue_fixer'],
      ['security_auditor', 'merged_pr_audit_scan'],
      ['code_quality_auditor', 'merged_pr_audit_scan'],
      ['ci_failure_triage', 'ci_failure_triage'],
    ]);
  });
});

import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  getTriggerableBackgroundAutomationSettingsHash,
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS,
} from '../background-automation-registry';

describe('background automation registry', () => {
  it('explicitly limits Additional rules to repository-scoped communication outputs', () => {
    expect(
      TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.filter(
        (descriptor) => 'additionalRules' in descriptor,
      ).map((descriptor) => descriptor.automationKey),
    ).toEqual([
      'suggester',
      'announcer',
      'security_auditor',
      'code_quality_auditor',
      'ci_failure_triage',
      'merge_announcer',
    ]);
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

  it('registers installed release announcements for manual cross-provider tests', () => {
    expect(
      getTriggerableBackgroundAutomationDescriptorByKey(
        'release_announcements',
      ),
    ).toMatchObject({
      label: 'Announce Roomote Updates',
      slackIcon: 'megaphone',
      scheduleModes: [],
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
      getTriggerableBackgroundAutomationSettingsHash('release_announcements'),
    ).toBe('release-announcements');
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

  it('registers Merge announcer as a provider-neutral push automation with cross-provider delivery', () => {
    expect(
      getTriggerableBackgroundAutomationDescriptorByKey('announcer')?.slackIcon,
    ).toBe('git-merge');

    const descriptor =
      getTriggerableBackgroundAutomationDescriptorByKey('merge_announcer');

    expect(descriptor).toMatchObject({
      label: 'Merge announcer',
      slackIcon: 'git-merge',
      scheduleModes: ['off', 'daily'],
      usesManagerChannel: true,
      supportedCommunicationProviders: [
        'slack',
        'teams',
        'telegram',
        'discord',
      ],
      supportedSourceControlProviders: [
        'github',
        'gitlab',
        'gitea',
        'ado',
        'bitbucket',
      ],
    });
    expect(
      getTriggerableBackgroundAutomationSettingsHash('merge_announcer'),
    ).toBe('merge-announcer');
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
});

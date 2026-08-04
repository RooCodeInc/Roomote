import {
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
} from '@roomote/types';

import {
  buildAutomationSettingsSaveInput,
  buildSaveStateForAutomation,
  mergeServerStatePreservingDirtySections,
  type FormState,
} from './formState';
import { applyReviewerAuthorSelection } from './reviewerSelection';
import {
  buildSlackWorkflowLaunchUrl,
  canSaveSentryTriageSettings,
  canSelectSentryTriageFrequency,
  getAutomationRunTooltip,
  isAutomationRunDisabled,
  isPlatformIssueAlertsEnabled,
  resolveAutomationHashTarget,
} from './AutomationsSettings';
import {
  createChannelAutoStartRowFromTemplate,
  getAvailableAutoRespondChannelTemplates,
} from './ChannelAutoStartEditor';

const baseFormState: FormState = {
  callRoomoteViaEmojiEnabled: false,
  callRoomoteViaEmojiName: '',
  callRoomoteViaEmojiInstructions: '',
  reviewerEnabled: false,
  reviewerEnvironmentScope: 'all' as const,
  reviewerEnvironmentIds: [] as string[],
  reviewerAuthorReviewMode: 'all' as const,
  reviewerCollaborators: [] as string[],
  reviewerExcludedAuthors: '',
  reviewerReviewAllPullRequestAuthors: false,
  reviewerReviewOnCommit: true,
  reviewerReviewDraftPrs: true,
  reviewerInstructions: '',
  reviewerRelayReviewResultsToTask: false,
  reviewerRelayUserIds: [] as string[],
  conflictResolverFrequency: 'off' as const,
  conflictResolverMaxPrAgeDays: 7 as const,
  conflictResolverLabel: 'roomote:auto-resolve-conflicts',
  conflictResolverInstructions: '',
  channelAutoStartChannels: [],
  managerSlackChannel: '',
  managerDiscordChannel: '',
  managerStatsFrequency: 'off' as const,
  managerStatsSlackChannel: '',
  managerStatsDiscordChannel: '',
  sentryTriageFrequency: 'off' as const,
  sentryTriageSlackChannel: '',
  sentryTriageDiscordChannel: '',
  sentryTriageProjectSlugs: '',
  dependabotTriageFrequency: 'off' as const,
  dependabotTriageSlackChannel: '',
  dependabotTriageDiscordChannel: '',
  codeqlTriageFrequency: 'off' as const,
  codeqlTriageSlackChannel: '',
  codeqlTriageDiscordChannel: '',
  issueFixerFrequency: 'off' as const,
  issueFixerInstructions: '',

  securityAuditorFrequency: 'off' as const,
  securityAuditorSlackChannel: '',
  securityAuditorDiscordChannel: '',
  codeQualityAuditorFrequency: 'off' as const,
  codeQualityAuditorSlackChannel: '',
  codeQualityAuditorDiscordChannel: '',
  ciFailureTriageFrequency: 'off' as const,
  ciFailureTriageSlackChannel: '',
  ciFailureTriageDiscordChannel: '',
  suggesterFrequency: 'off',
  suggesterSlackChannel: '',
  suggesterDiscordChannel: '',
  suggesterUseTelegram: false,
  suggesterUseTeams: false,
  suggesterInstructions: '',
  announcerFrequency: 'off' as const,
  announcerSlackChannel: '',
  announcerDiscordChannel: '',
  announcerInstructions: '',
  platformIssueSlackChannel: '',
  platformIssueDiscordChannel: '',
};

describe('Automations selection helpers', () => {
  it('includes emoji trigger settings in its save input', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        callRoomoteViaEmojiEnabled: true,
        callRoomoteViaEmojiName: ' :white_check_mark: ',
        callRoomoteViaEmojiInstructions: ' Prioritize safety. ',
      },
      baseFormState,
      'callRoomoteViaEmoji',
    );

    expect(saveInput).toMatchObject({
      savingAutomation: 'callRoomoteViaEmoji',
      callRoomoteViaEmojiEnabled: true,
      callRoomoteViaEmojiName: ':white_check_mark:',
      callRoomoteViaEmojiInstructions: 'Prioritize safety.',
    });
  });

  it('keeps author scope specific when the last author is removed', () => {
    const next = applyReviewerAuthorSelection(
      {
        ...baseFormState,
        reviewerAuthorReviewMode: 'specific',
        reviewerCollaborators: ['alice'],
      },
      [],
    );

    expect(next.reviewerAuthorReviewMode).toBe('specific');
    expect(next.reviewerCollaborators).toEqual([]);
  });

  it('keeps author scope specific when the mentions-only badge is removed', () => {
    const next = applyReviewerAuthorSelection(
      {
        ...baseFormState,
        reviewerAuthorReviewMode: 'none',
        reviewerCollaborators: [],
      },
      [],
    );

    expect(next.reviewerAuthorReviewMode).toBe('specific');
    expect(next.reviewerCollaborators).toEqual([]);
  });

  it('switches to mentions-only when that sentinel is selected', () => {
    const next = applyReviewerAuthorSelection(
      {
        ...baseFormState,
        reviewerAuthorReviewMode: 'specific',
        reviewerCollaborators: ['alice'],
      },
      ['alice', '__mentions_only__'],
    );

    expect(next.reviewerAuthorReviewMode).toBe('none');
    expect(next.reviewerCollaborators).toEqual([]);
  });

  it('drops all authors when a specific author is selected from that state', () => {
    const next = applyReviewerAuthorSelection(
      {
        ...baseFormState,
        reviewerAuthorReviewMode: 'all',
        reviewerCollaborators: [],
      },
      ['__all_authors__', 'alice'],
    );

    expect(next.reviewerAuthorReviewMode).toBe('specific');
    expect(next.reviewerCollaborators).toEqual(['alice']);
  });

  it('preserves dirty reviewer edits when a server refresh updates another section', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      reviewerEnvironmentScope: 'specific',
      reviewerEnvironmentIds: ['env-1'],
      reviewerAuthorReviewMode: 'specific',
      reviewerCollaborators: ['alice'],
      conflictResolverFrequency: 'daily',
    };

    const currentSavedState: FormState = {
      ...baseFormState,
      conflictResolverFrequency: 'daily',
    };

    const incomingState: FormState = {
      ...baseFormState,
      conflictResolverFrequency: 'daily',
      conflictResolverInstructions: 'updated from server',
    };

    const merged = mergeServerStatePreservingDirtySections(
      currentFormState,
      currentSavedState,
      incomingState,
    );

    expect(merged.formState.reviewerEnvironmentScope).toBe('specific');
    expect(merged.formState.reviewerEnvironmentIds).toEqual(['env-1']);
    expect(merged.formState.reviewerCollaborators).toEqual(['alice']);
    expect(merged.savedState.reviewerEnvironmentScope).toBe('all');
    expect(merged.savedState.reviewerEnvironmentIds).toEqual([]);
    expect(merged.formState.conflictResolverFrequency).toBe('daily');
    expect(merged.savedState.conflictResolverFrequency).toBe('daily');
    expect(merged.formState.conflictResolverInstructions).toBe(
      'updated from server',
    );
  });

  it('builds a save state that only applies the selected agent changes', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      announcerFrequency: 'daily',
      announcerInstructions: 'Unsaved announcer edit',
      suggesterInstructions: 'Only save this',
    };

    const currentSavedState: FormState = {
      ...baseFormState,
      announcerFrequency: 'off',
      announcerInstructions: '',
      suggesterInstructions: '',
    };

    const saveState = buildSaveStateForAutomation(
      currentFormState,
      currentSavedState,
      'suggester',
    );

    expect(saveState.suggesterInstructions).toBe('Only save this');
    expect(saveState.announcerFrequency).toBe('off');
    expect(saveState.announcerInstructions).toBe('');
  });

  it('includes trimmed reviewer instructions when saving Review Code', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        reviewerInstructions: '  Focus on security boundaries.  ',
      },
      baseFormState,
      'reviewer',
    );

    expect(saveInput.reviewerInstructions).toBe(
      'Focus on security boundaries.',
    );
  });

  it('builds a save state that only applies the channel auto-start changes', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      channelAutoStartChannels: [
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#bugs',
          instructions: 'Treat each message as a bug report.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ],
      managerSlackChannel: '#managers',
    };

    const currentSavedState: FormState = {
      ...baseFormState,
      managerSlackChannel: '#managers',
    };

    const saveState = buildSaveStateForAutomation(
      currentFormState,
      currentSavedState,
      'channelAutoStart',
    );

    expect(saveState.channelAutoStartChannels).toEqual([
      {
        provider: 'slack',
        channelId: null,
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);
    expect(saveState.managerSlackChannel).toBe('#managers');
  });

  it('sends the persisted channel id for an untouched channel auto-start row so the server resolves it by id instead of by name', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      channelAutoStartChannels: [
        // Hydrated from the server: a channel the user is not editing. Its name
        // may no longer resolve (archived/renamed), but its id still does.
        {
          provider: 'slack' as const,
          channelId: 'C0DEEP',
          slackChannel: '#deepstrike-roo',
          instructions: 'Handle deep strike reports.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ],
    };

    const saveInput = buildAutomationSettingsSaveInput(
      currentFormState,
      baseFormState,
      'channelAutoStart',
    );

    expect(saveInput.channelAutoStartSlackChannels).toEqual([
      {
        channelId: 'C0DEEP',
        slackChannel: '#deepstrike-roo',
        instructions: 'Handle deep strike reports.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: null,
      },
    ]);
  });

  it('splits merged auto-respond rows into Slack and Discord API arrays', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        channelAutoStartChannels: [
          {
            provider: 'slack' as const,
            channelId: 'C0BUGS',
            slackChannel: '#bugs',
            instructions: 'Bug triage.',
            launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
            launchCriteria: '',
          },
          {
            provider: 'discord' as const,
            channelId: '400000000000000001',
            slackChannel: '',
            instructions: 'Alert triage.',
            launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
            launchCriteria: '  Only launch on new alerts.  ',
          },
        ],
      },
      baseFormState,
      'channelAutoStart',
    );

    expect(saveInput.channelAutoStartSlackChannels).toEqual([
      {
        channelId: 'C0BUGS',
        slackChannel: '#bugs',
        instructions: 'Bug triage.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: null,
      },
    ]);
    // Always present (only legacy clients omit the field, which the API reads
    // as "preserve persisted Discord rows").
    expect(saveInput.channelAutoStartDiscordChannels).toEqual([
      {
        channelId: '400000000000000001',
        instructions: 'Alert triage.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new alerts.',
      },
    ]);
  });

  it('builds an API save input from the merged agent save state', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      announcerFrequency: 'daily',
      announcerSlackChannel: '  #announcements  ',
      announcerInstructions: '  Keep the summary short.  ',
      managerSlackChannel: '  #managers  ',
      securityAuditorFrequency: 'daily',
      securityAuditorSlackChannel: '  #security  ',
      reviewerReviewAllPullRequestAuthors: true,
    };

    const currentSavedState: FormState = {
      ...baseFormState,
      managerSlackChannel: '#saved-managers',
      securityAuditorFrequency: 'off',
      securityAuditorSlackChannel: '',
      reviewerReviewAllPullRequestAuthors: false,
    };

    const saveInput = buildAutomationSettingsSaveInput(
      currentFormState,
      currentSavedState,
      'announcer',
    );

    expect(saveInput).toEqual(
      expect.objectContaining({
        savingAutomation: 'announcer',
        announcerFrequency: 'daily',
        announcerSlackChannel: '#announcements',
        announcerInstructions: 'Keep the summary short.',
        managerSlackChannel: '#saved-managers',
        securityAuditorFrequency: 'off',
        securityAuditorSlackChannel: null,
        reviewerReviewAllPullRequestAuthors: false,
      }),
    );
  });

  it('includes the automation Discord destination in the API save input', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        managerStatsFrequency: 'weekly',
        managerStatsSlackChannel: '',
        managerStatsDiscordChannel: ' 123456789 ',
      },
      baseFormState,
      'managerStats',
    );

    expect(saveInput.managerStatsDiscordChannel).toBe('123456789');
    expect(saveInput.managerStatsSlackChannel).toBeNull();
  });

  it('includes the Discord manager destination in the API save input', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        managerSlackChannel: '',
        managerDiscordChannel: ' 123456789 ',
      },
      baseFormState,
      'managerChannel',
    );

    expect(saveInput.managerSlackChannel).toBeNull();
    expect(saveInput.managerDiscordChannel).toBe('123456789');
  });

  it('includes the reviewer all-author setting when saving Review Code', () => {
    const saveInput = buildAutomationSettingsSaveInput(
      {
        ...baseFormState,
        reviewerReviewAllPullRequestAuthors: true,
      },
      baseFormState,
      'reviewer',
    );

    expect(saveInput.reviewerReviewAllPullRequestAuthors).toBe(true);
  });

  it('creates a prefilled channel auto-start row from a template', () => {
    expect(
      createChannelAutoStartRowFromTemplate({
        channel: '#bugs',
        instructions: 'Treat each message as a bug report.',
      }),
    ).toEqual({
      provider: 'slack',
      channelId: null,
      slackChannel: '#bugs',
      instructions: 'Treat each message as a bug report.',
      launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      launchCriteria: '',
    });
  });

  it('keeps unused auto-respond templates available after one preset is added', () => {
    expect(
      getAvailableAutoRespondChannelTemplates([
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#bugs',
          instructions: 'Treat each message as a bug report.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ]).map((template) => template.channel),
    ).toEqual(['#support-inbound', '#ask-engineering', '#ops-requests']);
  });

  it('returns no auto-respond templates after every preset is already configured', () => {
    expect(
      getAvailableAutoRespondChannelTemplates([
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#bugs',
          instructions: 'Treat each message as a bug report.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#support-inbound',
          instructions: 'Treat each message as a support request.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#ask-engineering',
          instructions: 'Treat each message as a technical question.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
        {
          provider: 'slack' as const,
          channelId: null,
          slackChannel: '#ops-requests',
          instructions: 'Treat each message as an operational request.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ]),
    ).toEqual([]);
  });

  it('builds a save state that clears a previously saved channel auto-start prompt', () => {
    const currentFormState: FormState = {
      ...baseFormState,
      channelAutoStartChannels: [
        {
          provider: 'slack' as const,
          channelId: 'C0BUGS',
          slackChannel: '#bugs',
          instructions: '',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ],
    };

    const currentSavedState: FormState = {
      ...baseFormState,
      channelAutoStartChannels: [
        {
          provider: 'slack' as const,
          channelId: 'C0BUGS',
          slackChannel: '#bugs',
          instructions: 'Treat each message as a bug report.',
          launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: '',
        },
      ],
    };

    const saveState = buildSaveStateForAutomation(
      currentFormState,
      currentSavedState,
      'channelAutoStart',
    );

    expect(saveState.channelAutoStartChannels).toEqual([
      {
        provider: 'slack',
        channelId: 'C0BUGS',
        slackChannel: '#bugs',
        instructions: '',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);
  });

  it.each(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map(
      (automation) => [automation.label, automation] as const,
    ),
  )(
    'builds a save state that only applies %s schedule changes',
    (_label, automation) => {
      const currentFormState: FormState = {
        ...baseFormState,
        [automation.frequencyField]: 'daily',
        announcerFrequency: 'weekly',
      };

      const currentSavedState: FormState = {
        ...baseFormState,
        announcerFrequency: 'off',
      };

      const saveState = buildSaveStateForAutomation(
        currentFormState,
        currentSavedState,
        automation.id,
      );

      expect(saveState[automation.frequencyField]).toBe('daily');

      for (const otherAutomation of SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST) {
        if (otherAutomation.id === automation.id) {
          continue;
        }

        expect(saveState[otherAutomation.frequencyField]).toBe('off');
      }

      expect(saveState.announcerFrequency).toBe('off');
    },
  );

  it('maps #resolve-pr-conflicts hash to the conflict resolver section', () => {
    expect(resolveAutomationHashTarget('#resolve-pr-conflicts')).toBe(
      'conflictResolver',
    );
  });

  it('maps #auto-start-tasks hash to the channel auto-start section', () => {
    expect(resolveAutomationHashTarget('#auto-start-tasks')).toBe(
      'channelAutoStart',
    );
  });

  it('maps #suggest-ideas hash to the suggester section', () => {
    expect(resolveAutomationHashTarget('#suggest-ideas')).toBe('suggester');
  });

  it('does not map the retired self-improvements hash to a settings section', () => {
    expect(
      resolveAutomationHashTarget('#suggest-self-improvements'),
    ).toBeNull();
    expect(resolveAutomationHashTarget('#coach')).toBeNull();
  });

  it('maps #summarize-merged-prs hash to the announcer section', () => {
    expect(resolveAutomationHashTarget('#summarize-merged-prs')).toBe(
      'announcer',
    );
  });

  it('maps #dependabot-triage hash to the Dependabot triage section', () => {
    expect(resolveAutomationHashTarget('#dependabot-triage')).toBe(
      'dependabotTriage',
    );
  });

  it('maps #codeql-triage hash to the CodeQL triage section', () => {
    expect(resolveAutomationHashTarget('#codeql-triage')).toBe('codeqlTriage');
    expect(resolveAutomationHashTarget('#issue-fixer')).toBe('issueFixer');
  });

  it('maps #security-auditor hash to the security auditor section', () => {
    expect(resolveAutomationHashTarget('#security-auditor')).toBe(
      'securityAuditor',
    );
  });

  it('maps #code-quality-auditor hash to the code quality auditor section', () => {
    expect(resolveAutomationHashTarget('#code-quality-auditor')).toBe(
      'codeQualityAuditor',
    );
  });

  it('builds a workspace-specific Slack workflow URL when a team domain exists', () => {
    expect(buildSlackWorkflowLaunchUrl('acme-team')).toBe(
      'https://acme-team.slack.com/launch-workflows',
    );
  });

  it('falls back to the generic Slack workflow URL when no team domain exists', () => {
    expect(buildSlackWorkflowLaunchUrl(null)).toBe(
      'https://slack.com/launch-workflows',
    );
  });

  it('treats platform issue alerts as disabled without a selected channel', () => {
    expect(
      isPlatformIssueAlertsEnabled({
        platformIssueSlackChannel: '',
        platformIssueDiscordChannel: '',
      }),
    ).toBe(false);
    expect(
      isPlatformIssueAlertsEnabled({
        platformIssueSlackChannel: '   ',
        platformIssueDiscordChannel: '   ',
      }),
    ).toBe(false);
  });

  it('treats platform issue alerts as enabled when a Slack channel is selected', () => {
    expect(
      isPlatformIssueAlertsEnabled({
        platformIssueSlackChannel: 'C123',
        platformIssueDiscordChannel: '',
      }),
    ).toBe(true);
  });

  it('treats platform issue alerts as enabled when a Discord channel is selected', () => {
    expect(
      isPlatformIssueAlertsEnabled({
        platformIssueSlackChannel: '',
        platformIssueDiscordChannel: '111222333444555666',
      }),
    ).toBe(true);
  });

  it('requires a Sentry connection before selecting an enabled Sentry triage schedule', () => {
    expect(
      canSelectSentryTriageFrequency({
        sentryConnected: false,
        frequency: 'daily',
      }),
    ).toBe(false);
    expect(
      canSelectSentryTriageFrequency({
        sentryConnected: false,
        frequency: 'off',
      }),
    ).toBe(true);
    expect(
      canSelectSentryTriageFrequency({
        sentryConnected: true,
        frequency: 'weekly',
      }),
    ).toBe(true);
  });

  it('lets disconnected Sentry triage settings be saved only when disabling', () => {
    expect(
      canSaveSentryTriageSettings({
        sentryConnected: false,
        frequency: 'daily',
      }),
    ).toBe(false);
    expect(
      canSaveSentryTriageSettings({
        sentryConnected: false,
        frequency: 'off',
      }),
    ).toBe(true);
  });

  it('disables manual runs while saved settings are missing or stale', () => {
    expect(
      isAutomationRunDisabled({
        isEnabled: true,
        isDirty: true,
        isSaving: false,
        isTriggering: false,
      }),
    ).toBe(true);
    expect(
      isAutomationRunDisabled({
        isEnabled: true,
        isDirty: false,
        isSaving: false,
        isTriggering: false,
        isBlocked: true,
      }),
    ).toBe(true);
    expect(
      isAutomationRunDisabled({
        isEnabled: true,
        isDirty: false,
        isSaving: false,
        isTriggering: false,
      }),
    ).toBe(false);
  });

  it('explains why a manual run is unavailable', () => {
    expect(
      getAutomationRunTooltip({
        isEnabled: true,
        isDirty: true,
        isSaving: false,
      }),
    ).toBe('Save settings first');
    expect(
      getAutomationRunTooltip({
        isEnabled: true,
        isDirty: false,
        isSaving: false,
        blockedReason: 'Set and save a Manager Channel first',
      }),
    ).toBe('Set and save a Manager Channel first');
  });
});

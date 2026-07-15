import {
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
  type ChannelAutoStartLaunchMode,
  type ConflictResolverMaxPrAgeDays,
  type ScheduleOnlyBackgroundAutomationFrequency,
  type ScheduleOnlyBackgroundAutomationFrequencyField,
  type ScheduleOnlyBackgroundAutomationId,
  type SuggesterRoutingMode,
} from '@roomote/types';

export type ConflictResolverFrequency =
  | 'off'
  | 'every_hour'
  | 'every_6_hours'
  | 'daily';
export type SuggesterFrequency = 'off' | 'daily' | 'weekly';
export type AnnouncerFrequency = 'off' | 'daily' | 'weekly';
export type ManagerStatsFrequency = 'off' | 'weekly';
export type SentryTriageFrequency = 'off' | 'daily' | 'weekly';
export type DependabotTriageFrequency = 'off' | 'daily' | 'weekly';
export type ReviewerEnvironmentScope = 'all' | 'specific';
export type ReviewerAuthorReviewMode = 'all' | 'specific' | 'none';

export type ChannelAutoStartFormRow = {
  // Canonical Slack channel ID persisted for this row, or null for rows the
  // user just added or whose channel field they edited. When present it is the
  // authoritative identity so saving never has to re-resolve the channel by
  // name (which fails for archived/renamed/private channels).
  channelId: string | null;
  slackChannel: string;
  instructions: string;
  launchMode: ChannelAutoStartLaunchMode;
  launchCriteria: string;
};

type ScheduleOnlyAutomationFormFields = Record<
  ScheduleOnlyBackgroundAutomationFrequencyField,
  ScheduleOnlyBackgroundAutomationFrequency
>;

type ScheduleOnlyAutomationFrequencyState = Pick<
  FormState,
  ScheduleOnlyBackgroundAutomationFrequencyField
>;

export type FormState = {
  reviewerEnabled: boolean;
  reviewerEnvironmentScope: ReviewerEnvironmentScope;
  reviewerEnvironmentIds: string[];
  reviewerAuthorReviewMode: ReviewerAuthorReviewMode;
  reviewerCollaborators: string[];
  reviewerExcludedAuthors: string;
  reviewerReviewAllPullRequestAuthors: boolean;
  reviewerReviewOnCommit: boolean;
  reviewerReviewDraftPrs: boolean;
  reviewerRelayReviewResultsToTask: boolean;
  reviewerRelayUserIds: string[];
  conflictResolverFrequency: ConflictResolverFrequency;
  conflictResolverMaxPrAgeDays: ConflictResolverMaxPrAgeDays;
  conflictResolverLabel: string;
  conflictResolverInstructions: string;
  channelAutoStartSlackChannels: ChannelAutoStartFormRow[];
  managerSlackChannel: string;
  managerStatsFrequency: ManagerStatsFrequency;
  managerStatsSlackChannel: string;
  managerStatsDiscordChannel: string;
  sentryTriageFrequency: SentryTriageFrequency;
  sentryTriageSlackChannel: string;
  sentryTriageDiscordChannel: string;
  sentryTriageProjectSlugs: string;
  dependabotTriageFrequency: DependabotTriageFrequency;
  dependabotTriageSlackChannel: string;
  dependabotTriageDiscordChannel: string;
  suggesterFrequency: SuggesterFrequency;
  suggesterSlackChannel: string;
  suggesterInstructions: string;
  suggesterRoutingMode: SuggesterRoutingMode;
  suggesterRoutingInstructions: string;
  announcerFrequency: AnnouncerFrequency;
  announcerSlackChannel: string;
  announcerInstructions: string;
  platformIssueSlackChannel: string;
  securityAuditorSlackChannel: string;
  securityAuditorDiscordChannel: string;
  codeQualityAuditorSlackChannel: string;
  codeQualityAuditorDiscordChannel: string;
  ciFailureTriageSlackChannel: string;
  ciFailureTriageDiscordChannel: string;
} & ScheduleOnlyAutomationFormFields;

export type AutomationId =
  | 'channelAutoStart'
  | 'managerChannel'
  | 'managerStats'
  | 'sentryTriage'
  | 'dependabotTriage'
  | ScheduleOnlyBackgroundAutomationId
  | 'reviewer'
  | 'conflictResolver'
  | 'suggester'
  | 'announcer'
  | 'platformIssueAlerts';

const REVIEWER_FIELDS: Array<keyof FormState> = [
  'reviewerEnabled',
  'reviewerEnvironmentScope',
  'reviewerEnvironmentIds',
  'reviewerAuthorReviewMode',
  'reviewerCollaborators',
  'reviewerExcludedAuthors',
  'reviewerReviewAllPullRequestAuthors',
  'reviewerReviewOnCommit',
  'reviewerReviewDraftPrs',
  'reviewerRelayReviewResultsToTask',
  'reviewerRelayUserIds',
];

const CONFLICT_RESOLVER_FIELDS: Array<keyof FormState> = [
  'conflictResolverFrequency',
  'conflictResolverMaxPrAgeDays',
  'conflictResolverLabel',
  'conflictResolverInstructions',
];

const CHANNEL_AUTO_START_FIELDS: Array<keyof FormState> = [
  'channelAutoStartSlackChannels',
];

const MANAGER_CHANNEL_FIELDS: Array<keyof FormState> = ['managerSlackChannel'];

const MANAGER_STATS_FIELDS: Array<keyof FormState> = [
  'managerStatsFrequency',
  'managerStatsSlackChannel',
  'managerStatsDiscordChannel',
];

const SENTRY_TRIAGE_FIELDS: Array<keyof FormState> = [
  'sentryTriageFrequency',
  'sentryTriageSlackChannel',
  'sentryTriageDiscordChannel',
  'sentryTriageProjectSlugs',
];

const DEPENDABOT_TRIAGE_FIELDS: Array<keyof FormState> = [
  'dependabotTriageFrequency',
  'dependabotTriageSlackChannel',
  'dependabotTriageDiscordChannel',
];

const SUGGESTER_FIELDS: Array<keyof FormState> = [
  'suggesterFrequency',
  'suggesterSlackChannel',
  'suggesterInstructions',
  'suggesterRoutingMode',
  'suggesterRoutingInstructions',
];

const ANNOUNCER_FIELDS: Array<keyof FormState> = [
  'announcerFrequency',
  'announcerSlackChannel',
  'announcerInstructions',
];

const PLATFORM_ISSUE_ALERT_FIELDS: Array<keyof FormState> = [
  'platformIssueSlackChannel',
];

const SCHEDULE_ONLY_AUTOMATION_FIELDS = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.id,
    [
      automation.frequencyField,
      ...(automation.id === 'securityAuditor'
        ? ['securityAuditorSlackChannel', 'securityAuditorDiscordChannel']
        : automation.id === 'codeQualityAuditor'
          ? [
              'codeQualityAuditorSlackChannel',
              'codeQualityAuditorDiscordChannel',
            ]
          : ['ciFailureTriageSlackChannel', 'ciFailureTriageDiscordChannel']),
    ],
  ]),
) as Record<ScheduleOnlyBackgroundAutomationId, Array<keyof FormState>>;

const AUTOMATION_FIELDS: Record<AutomationId, Array<keyof FormState>> = {
  channelAutoStart: CHANNEL_AUTO_START_FIELDS,
  managerChannel: MANAGER_CHANNEL_FIELDS,
  managerStats: MANAGER_STATS_FIELDS,
  sentryTriage: SENTRY_TRIAGE_FIELDS,
  dependabotTriage: DEPENDABOT_TRIAGE_FIELDS,
  ...SCHEDULE_ONLY_AUTOMATION_FIELDS,
  reviewer: REVIEWER_FIELDS,
  conflictResolver: CONFLICT_RESOLVER_FIELDS,
  suggester: SUGGESTER_FIELDS,
  announcer: ANNOUNCER_FIELDS,
  platformIssueAlerts: PLATFORM_ISSUE_ALERT_FIELDS,
};

export function isAutomationDirty(
  formState: FormState,
  savedState: FormState,
  automationId: AutomationId,
): boolean {
  return AUTOMATION_FIELDS[automationId].some(
    (field) => formState[field] !== savedState[field],
  );
}

export function resetAutomationFields(
  formState: FormState,
  savedState: FormState,
  automationId: AutomationId,
): FormState {
  const updated = { ...formState };
  for (const field of AUTOMATION_FIELDS[automationId]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (updated as any)[field] = savedState[field];
  }
  return updated;
}

export function mergeAutomationFields(
  currentState: FormState,
  nextState: FormState,
  automationId: AutomationId,
): FormState {
  const updated = { ...currentState };
  for (const field of AUTOMATION_FIELDS[automationId]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (updated as any)[field] = nextState[field];
  }
  return updated;
}

export function buildSaveStateForAutomation(
  formState: FormState,
  savedState: FormState,
  automationId: AutomationId,
): FormState {
  return mergeAutomationFields(savedState, formState, automationId);
}

function buildScheduleOnlyAutomationSaveInput(
  formState: FormState,
): ScheduleOnlyAutomationFrequencyState {
  return Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.frequencyField,
      formState[automation.frequencyField],
    ]),
  ) as ScheduleOnlyAutomationFrequencyState;
}

export function buildAutomationSettingsSaveInput(
  formState: FormState,
  savedState: FormState,
  automationId: AutomationId,
) {
  const stateToSave = buildSaveStateForAutomation(
    formState,
    savedState,
    automationId,
  );

  return {
    savingAutomation: automationId,
    reviewerEnabled: stateToSave.reviewerEnabled,
    reviewerEnvironmentScope: 'all' as const,
    reviewerEnvironmentIds: [],
    reviewerAuthorReviewMode: stateToSave.reviewerAuthorReviewMode,
    reviewerCollaborators: stateToSave.reviewerCollaborators,
    reviewerExcludedAuthors: stateToSave.reviewerExcludedAuthors.trim() || null,
    reviewerReviewAllPullRequestAuthors:
      stateToSave.reviewerReviewAllPullRequestAuthors,
    reviewerReviewOnCommit: stateToSave.reviewerReviewOnCommit,
    reviewerReviewDraftPrs: stateToSave.reviewerReviewDraftPrs,
    reviewerRelayReviewResultsToTask:
      stateToSave.reviewerRelayReviewResultsToTask,
    reviewerRelayUserIds: stateToSave.reviewerRelayUserIds,
    conflictResolverFrequency: stateToSave.conflictResolverFrequency,
    conflictResolverMaxPrAgeDays: stateToSave.conflictResolverMaxPrAgeDays,
    conflictResolverLabel: stateToSave.conflictResolverLabel,
    conflictResolverInstructions:
      stateToSave.conflictResolverInstructions.trim() || null,
    channelAutoStartSlackChannels:
      stateToSave.channelAutoStartSlackChannels.map((row) => ({
        channelId: row.channelId,
        slackChannel: row.slackChannel.trim() || null,
        instructions: row.instructions.trim() || null,
        launchMode: row.launchMode,
        launchCriteria: row.launchCriteria.trim() || null,
      })),
    managerSlackChannel: stateToSave.managerSlackChannel.trim() || null,
    managerStatsFrequency: stateToSave.managerStatsFrequency,
    managerStatsSlackChannel:
      stateToSave.managerStatsSlackChannel.trim() || null,
    managerStatsDiscordChannel:
      stateToSave.managerStatsDiscordChannel.trim() || null,
    sentryTriageFrequency: stateToSave.sentryTriageFrequency,
    sentryTriageSlackChannel:
      stateToSave.sentryTriageSlackChannel.trim() || null,
    sentryTriageDiscordChannel:
      stateToSave.sentryTriageDiscordChannel.trim() || null,
    sentryTriageProjectSlugs:
      stateToSave.sentryTriageProjectSlugs.trim() || null,
    dependabotTriageFrequency: stateToSave.dependabotTriageFrequency,
    dependabotTriageSlackChannel:
      stateToSave.dependabotTriageSlackChannel.trim() || null,
    dependabotTriageDiscordChannel:
      stateToSave.dependabotTriageDiscordChannel.trim() || null,
    ...buildScheduleOnlyAutomationSaveInput(stateToSave),
    suggesterFrequency: stateToSave.suggesterFrequency,
    suggesterSlackChannel: stateToSave.suggesterSlackChannel.trim() || null,
    suggesterInstructions: stateToSave.suggesterInstructions.trim() || null,
    suggesterRoutingMode: stateToSave.suggesterRoutingMode,
    suggesterRoutingInstructions:
      stateToSave.suggesterRoutingInstructions.trim() || null,
    announcerFrequency: stateToSave.announcerFrequency,
    announcerSlackChannel: stateToSave.announcerSlackChannel.trim() || null,
    announcerInstructions: stateToSave.announcerInstructions.trim() || null,
    platformIssueSlackChannel:
      stateToSave.platformIssueSlackChannel.trim() || null,
    securityAuditorSlackChannel:
      stateToSave.securityAuditorSlackChannel.trim() || null,
    securityAuditorDiscordChannel:
      stateToSave.securityAuditorDiscordChannel.trim() || null,
    codeQualityAuditorSlackChannel:
      stateToSave.codeQualityAuditorSlackChannel.trim() || null,
    codeQualityAuditorDiscordChannel:
      stateToSave.codeQualityAuditorDiscordChannel.trim() || null,
    ciFailureTriageSlackChannel:
      stateToSave.ciFailureTriageSlackChannel.trim() || null,
    ciFailureTriageDiscordChannel:
      stateToSave.ciFailureTriageDiscordChannel.trim() || null,
  };
}

export function mergeServerStatePreservingDirtySections(
  currentFormState: FormState,
  currentSavedState: FormState,
  incomingState: FormState,
): {
  formState: FormState;
  savedState: FormState;
} {
  let nextFormState = { ...incomingState };
  let nextSavedState = { ...incomingState };

  for (const automationId of Object.keys(AUTOMATION_FIELDS) as AutomationId[]) {
    if (isAutomationDirty(currentFormState, currentSavedState, automationId)) {
      nextFormState = mergeAutomationFields(
        nextFormState,
        currentFormState,
        automationId,
      );
      nextSavedState = mergeAutomationFields(
        nextSavedState,
        currentSavedState,
        automationId,
      );
    }
  }

  return {
    formState: nextFormState,
    savedState: nextSavedState,
  };
}

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
  sentryTriageFrequency: SentryTriageFrequency;
  sentryTriageSlackChannel: string;
  sentryTriageProjectSlugs: string;
  dependabotTriageFrequency: DependabotTriageFrequency;
  dependabotTriageSlackChannel: string;
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
  codeQualityAuditorSlackChannel: string;
  ciFailureTriageSlackChannel: string;
} & ScheduleOnlyAutomationFormFields;

export type AgentType =
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
];

const SENTRY_TRIAGE_FIELDS: Array<keyof FormState> = [
  'sentryTriageFrequency',
  'sentryTriageSlackChannel',
  'sentryTriageProjectSlugs',
];

const DEPENDABOT_TRIAGE_FIELDS: Array<keyof FormState> = [
  'dependabotTriageFrequency',
  'dependabotTriageSlackChannel',
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

const SCHEDULE_ONLY_AGENT_FIELDS = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.id,
    [
      automation.frequencyField,
      automation.id === 'securityAuditor'
        ? 'securityAuditorSlackChannel'
        : automation.id === 'codeQualityAuditor'
          ? 'codeQualityAuditorSlackChannel'
          : 'ciFailureTriageSlackChannel',
    ],
  ]),
) as Record<ScheduleOnlyBackgroundAutomationId, Array<keyof FormState>>;

const AGENT_FIELDS: Record<AgentType, Array<keyof FormState>> = {
  channelAutoStart: CHANNEL_AUTO_START_FIELDS,
  managerChannel: MANAGER_CHANNEL_FIELDS,
  managerStats: MANAGER_STATS_FIELDS,
  sentryTriage: SENTRY_TRIAGE_FIELDS,
  dependabotTriage: DEPENDABOT_TRIAGE_FIELDS,
  ...SCHEDULE_ONLY_AGENT_FIELDS,
  reviewer: REVIEWER_FIELDS,
  conflictResolver: CONFLICT_RESOLVER_FIELDS,
  suggester: SUGGESTER_FIELDS,
  announcer: ANNOUNCER_FIELDS,
  platformIssueAlerts: PLATFORM_ISSUE_ALERT_FIELDS,
};

export function isAgentDirty(
  formState: FormState,
  savedState: FormState,
  agent: AgentType,
): boolean {
  return AGENT_FIELDS[agent].some(
    (field) => formState[field] !== savedState[field],
  );
}

export function resetAgentFields(
  formState: FormState,
  savedState: FormState,
  agent: AgentType,
): FormState {
  const updated = { ...formState };
  for (const field of AGENT_FIELDS[agent]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (updated as any)[field] = savedState[field];
  }
  return updated;
}

export function mergeAgentFields(
  currentState: FormState,
  nextState: FormState,
  agent: AgentType,
): FormState {
  const updated = { ...currentState };
  for (const field of AGENT_FIELDS[agent]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (updated as any)[field] = nextState[field];
  }
  return updated;
}

export function buildSaveStateForAgent(
  formState: FormState,
  savedState: FormState,
  agent: AgentType,
): FormState {
  return mergeAgentFields(savedState, formState, agent);
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
  agent: AgentType,
) {
  const stateToSave = buildSaveStateForAgent(formState, savedState, agent);

  return {
    savingAgent: agent,
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
        slackChannel: row.slackChannel.trim() || null,
        instructions: row.instructions.trim() || null,
        launchMode: row.launchMode,
        launchCriteria: row.launchCriteria.trim() || null,
      })),
    managerSlackChannel: stateToSave.managerSlackChannel.trim() || null,
    managerStatsFrequency: stateToSave.managerStatsFrequency,
    managerStatsSlackChannel:
      stateToSave.managerStatsSlackChannel.trim() || null,
    sentryTriageFrequency: stateToSave.sentryTriageFrequency,
    sentryTriageSlackChannel:
      stateToSave.sentryTriageSlackChannel.trim() || null,
    sentryTriageProjectSlugs:
      stateToSave.sentryTriageProjectSlugs.trim() || null,
    dependabotTriageFrequency: stateToSave.dependabotTriageFrequency,
    dependabotTriageSlackChannel:
      stateToSave.dependabotTriageSlackChannel.trim() || null,
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
    codeQualityAuditorSlackChannel:
      stateToSave.codeQualityAuditorSlackChannel.trim() || null,
    ciFailureTriageSlackChannel:
      stateToSave.ciFailureTriageSlackChannel.trim() || null,
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

  for (const agent of Object.keys(AGENT_FIELDS) as AgentType[]) {
    if (isAgentDirty(currentFormState, currentSavedState, agent)) {
      nextFormState = mergeAgentFields(nextFormState, currentFormState, agent);
      nextSavedState = mergeAgentFields(
        nextSavedState,
        currentSavedState,
        agent,
      );
    }
  }

  return {
    formState: nextFormState,
    savedState: nextSavedState,
  };
}

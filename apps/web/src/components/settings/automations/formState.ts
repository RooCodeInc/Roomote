import {
  AUTOMATION_DESTINATION_DESCRIPTORS,
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
export type CodeqlTriageFrequency = 'off' | 'daily' | 'weekly';
export type ReviewerEnvironmentScope = 'all' | 'specific';
export type ReviewerAuthorReviewMode = 'all' | 'specific' | 'none';

export type ChannelAutoStartFormRow = {
  provider: 'slack' | 'discord';
  // Canonical channel ID persisted for this row, or null for rows the user
  // just added or whose channel field they edited. For Slack rows it is the
  // resolved channel id (authoritative, so saving never has to re-resolve the
  // channel by name, which fails for archived/renamed/private channels); for
  // Discord rows it is the catalog channel id selected in the picker.
  channelId: string | null;
  /** Slack display name / free-text input; unused ('') for Discord rows. */
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

type DestinationChannelFormFields = {
  [K in
    | (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['slackField']
    | (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['discordField']]: string;
};

const DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID = Object.fromEntries(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.automationId,
    [descriptor.slackField, descriptor.discordField],
  ]),
) as Record<
  (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['automationId'],
  Array<keyof FormState>
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
  issueFixerInstructions: string;
  /** Merged, provider-tagged auto-respond rows (Slack and Discord). */
  channelAutoStartChannels: ChannelAutoStartFormRow[];
  managerSlackChannel: string;
  managerStatsFrequency: ManagerStatsFrequency;
  sentryTriageFrequency: SentryTriageFrequency;
  sentryTriageProjectSlugs: string;
  dependabotTriageFrequency: DependabotTriageFrequency;
  codeqlTriageFrequency: CodeqlTriageFrequency;
  suggesterFrequency: SuggesterFrequency;
  suggesterInstructions: string;
  /**
   * When true, Suggest Ideas delivers to a sticky Telegram forum topic
   * (created once, reused). Mutually exclusive with Slack/Discord channels.
   */
  suggesterUseTelegram: boolean;
  /**
   * When true, Suggest Ideas delivers to the primary Teams conversation.
   * Mutually exclusive with Slack/Discord/Telegram destinations.
   */
  suggesterUseTeams: boolean;
  suggesterRoutingMode: SuggesterRoutingMode;
  suggesterRoutingInstructions: string;
  announcerFrequency: AnnouncerFrequency;
  announcerInstructions: string;
} & DestinationChannelFormFields &
  ScheduleOnlyAutomationFormFields;

export type AutomationId =
  | 'channelAutoStart'
  | 'managerChannel'
  | 'managerStats'
  | 'sentryTriage'
  | 'dependabotTriage'
  | 'codeqlTriage'
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
  'channelAutoStartChannels',
];

const MANAGER_CHANNEL_FIELDS: Array<keyof FormState> = ['managerSlackChannel'];

const MANAGER_STATS_FIELDS: Array<keyof FormState> = [
  'managerStatsFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.managerStats,
];

const SENTRY_TRIAGE_FIELDS: Array<keyof FormState> = [
  'sentryTriageFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.sentryTriage,
  'sentryTriageProjectSlugs',
];

const DEPENDABOT_TRIAGE_FIELDS: Array<keyof FormState> = [
  'dependabotTriageFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.dependabotTriage,
];

const CODEQL_TRIAGE_FIELDS: Array<keyof FormState> = [
  'codeqlTriageFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.codeqlTriage,
];

const SUGGESTER_FIELDS: Array<keyof FormState> = [
  'suggesterFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.suggester,
  'suggesterUseTelegram',
  'suggesterUseTeams',
  'suggesterInstructions',
  'suggesterRoutingMode',
  'suggesterRoutingInstructions',
];

const ANNOUNCER_FIELDS: Array<keyof FormState> = [
  'announcerFrequency',
  ...DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.announcer,
  'announcerInstructions',
];

const PLATFORM_ISSUE_ALERT_FIELDS: Array<keyof FormState> =
  DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID.platformIssueAlerts;

const SCHEDULE_ONLY_AUTOMATION_FIELDS = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.id,
    [
      automation.frequencyField,
      ...(DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID[
        automation.id as keyof typeof DESTINATION_CHANNEL_FIELDS_BY_AUTOMATION_ID
      ] ?? []),
      ...(automation.id === 'issueFixer'
        ? (['issueFixerInstructions'] as const)
        : []),
    ],
  ]),
) as Record<ScheduleOnlyBackgroundAutomationId, Array<keyof FormState>>;

const AUTOMATION_FIELDS: Record<AutomationId, Array<keyof FormState>> = {
  channelAutoStart: CHANNEL_AUTO_START_FIELDS,
  managerChannel: MANAGER_CHANNEL_FIELDS,
  managerStats: MANAGER_STATS_FIELDS,
  sentryTriage: SENTRY_TRIAGE_FIELDS,
  dependabotTriage: DEPENDABOT_TRIAGE_FIELDS,
  codeqlTriage: CODEQL_TRIAGE_FIELDS,
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

function buildDestinationChannelSaveInput(formState: FormState) {
  return Object.fromEntries(
    AUTOMATION_DESTINATION_DESCRIPTORS.flatMap((descriptor) => [
      [descriptor.slackField, formState[descriptor.slackField].trim() || null],
      [
        descriptor.discordField,
        formState[descriptor.discordField].trim() || null,
      ],
    ]),
  ) as Record<
    | (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['slackField']
    | (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['discordField'],
    string | null
  >;
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
    channelAutoStartSlackChannels: stateToSave.channelAutoStartChannels
      .filter((row) => row.provider === 'slack')
      .map((row) => ({
        channelId: row.channelId,
        slackChannel: row.slackChannel.trim() || null,
        instructions: row.instructions.trim() || null,
        launchMode: row.launchMode,
        launchCriteria: row.launchCriteria.trim() || null,
      })),
    // Always sent (even empty) — only legacy clients omit it, which the API
    // treats as "preserve the persisted Discord rows".
    channelAutoStartDiscordChannels: stateToSave.channelAutoStartChannels
      .filter((row) => row.provider === 'discord')
      .map((row) => ({
        channelId: row.channelId,
        instructions: row.instructions.trim() || null,
        launchMode: row.launchMode,
        launchCriteria: row.launchCriteria.trim() || null,
      })),
    managerSlackChannel: stateToSave.managerSlackChannel.trim() || null,
    managerStatsFrequency: stateToSave.managerStatsFrequency,
    sentryTriageFrequency: stateToSave.sentryTriageFrequency,
    sentryTriageProjectSlugs:
      stateToSave.sentryTriageProjectSlugs.trim() || null,
    dependabotTriageFrequency: stateToSave.dependabotTriageFrequency,
    codeqlTriageFrequency: stateToSave.codeqlTriageFrequency,
    ...buildScheduleOnlyAutomationSaveInput(stateToSave),
    issueFixerInstructions: stateToSave.issueFixerInstructions.trim() || null,
    suggesterFrequency: stateToSave.suggesterFrequency,
    suggesterInstructions: stateToSave.suggesterInstructions.trim() || null,
    suggesterUseTelegram: stateToSave.suggesterUseTelegram,
    suggesterUseTeams: stateToSave.suggesterUseTeams,
    suggesterRoutingMode: stateToSave.suggesterRoutingMode,
    suggesterRoutingInstructions:
      stateToSave.suggesterRoutingInstructions.trim() || null,
    announcerFrequency: stateToSave.announcerFrequency,
    announcerInstructions: stateToSave.announcerInstructions.trim() || null,
    ...buildDestinationChannelSaveInput(stateToSave),
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

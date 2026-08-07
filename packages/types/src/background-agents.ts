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
export const SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES = [
  'off',
  'every_hour',
  'every_6_hours',
  'daily',
  'weekly',
] as const;
export type ScheduleOnlyBackgroundAutomationFrequency =
  (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES)[number];
export const CHANNEL_AUTO_START_LAUNCH_MODES = ['always_start'] as const;

export type ChannelAutoStartLaunchMode =
  (typeof CHANNEL_AUTO_START_LAUNCH_MODES)[number];

export const DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE: ChannelAutoStartLaunchMode =
  'always_start';

export function isChannelAutoStartLaunchMode(
  value: string,
): value is ChannelAutoStartLaunchMode {
  return (CHANNEL_AUTO_START_LAUNCH_MODES as readonly string[]).includes(value);
}

export function isScheduleOnlyBackgroundAutomationFrequency(
  value: string,
): value is ScheduleOnlyBackgroundAutomationFrequency {
  return (
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES as readonly string[]
  ).includes(value);
}

/** Cadence presets supported by user-defined custom automations. */
export type CustomAutomationScheduleMode =
  | ScheduleOnlyBackgroundAutomationFrequency
  | 'cron';

export const MAX_CUSTOM_AUTOMATIONS = 25;

export const CUSTOM_AUTOMATION_NAME_MAX_LENGTH = 100;

export const CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH = 8_000;
export const CUSTOM_AUTOMATION_CRON_MAX_LENGTH = 200;
export const CUSTOM_AUTOMATION_MODEL_MAX_LENGTH = 200;
export type SecurityAuditorFrequency =
  ScheduleOnlyBackgroundAutomationFrequency;

export type CodeQualityAuditorFrequency =
  ScheduleOnlyBackgroundAutomationFrequency;

// CI failure triage and Triage Issues are webhook-driven and have no schedule;
// 'daily' is only the stored enabled sentinel so they reuse the generic
// schedule-only settings machinery.
export type CiFailureTriageFrequency = 'off' | 'daily';

export type IssueFixerFrequency = 'off' | 'daily';

/**
 * User-facing automations shown on the Automations settings page. Each key is
 * the canonical snake_case identifier used everywhere: the automations table
 * primary key, tasks.initiator_automation, and BullMQ scheduler job names.
 */
export const USER_FACING_AUTOMATION_KEYS = [
  'review_code',
  'conflict_resolver',
  'suggester',
  'announcer',
  'call_roomote_via_emoji',
  // Channel auto-start for ALL chat providers (Slack + Discord targets live in
  // this one row, distinguished by target provider/targetKind). The key keeps
  // its historical Slack-only name because renaming an automations primary key
  // would break the N-1 rollback release.
  'slack_channel_auto_start',
  'manager_stats',
  'platform_issue_alerts',
  'sentry_triage',
  'dependabot_triage',
  'codeql_triage',
  'issue_fixer',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
] as const;

/**
 * Internal automations that launch tasks (and therefore need automations rows
 * for the tasks.initiator_automation FK) but are hidden from the settings UI.
 */
export const INTERNAL_AUTOMATION_KEYS = [
  'snapshot_refresh',
  'mcp_recommendations',
  'slack_workflow',
  // Seeds automations.key so custom-automation task launches can FK-stamp
  // initiator_automation. User-defined definitions live in custom_automations.
  'custom_automation',
] as const;

export const BACKGROUND_AUTOMATION_KEYS = [
  ...USER_FACING_AUTOMATION_KEYS,
  ...INTERNAL_AUTOMATION_KEYS,
] as const;

export type BackgroundAutomationKey =
  (typeof BACKGROUND_AUTOMATION_KEYS)[number];

export type InternalAutomationKey = (typeof INTERNAL_AUTOMATION_KEYS)[number];

const INTERNAL_AUTOMATION_KEY_SET = new Set<string>(INTERNAL_AUTOMATION_KEYS);

export function isInternalAutomationKey(
  key: BackgroundAutomationKey,
): key is InternalAutomationKey {
  return INTERNAL_AUTOMATION_KEY_SET.has(key);
}

export function isBackgroundAutomationKey(
  value: string,
): value is BackgroundAutomationKey {
  return (BACKGROUND_AUTOMATION_KEYS as readonly string[]).includes(value);
}

export type BackgroundAutomationProvider =
  | 'slack'
  | 'teams'
  | 'telegram'
  | 'discord'
  | 'sentry';

export type BackgroundAutomationTargetKind =
  | 'slack_channel'
  | 'slack_user'
  | 'teams_channel'
  | 'telegram_chat'
  | 'discord_channel'
  | 'sentry_project';

/**
 * A single automation target stored in automations.targets (jsonb array).
 */
export type AutomationTarget = {
  provider: BackgroundAutomationProvider;
  targetKind: BackgroundAutomationTargetKind;
  externalRef: string;
  metadata?: Record<string, unknown>;
};

/**
 * A custom automation's stored report destination: a full AutomationTarget,
 * or the empty object (the column default) when no report destination is
 * configured.
 */
export type OptionalAutomationTarget = AutomationTarget | Record<string, never>;

export function isConfiguredAutomationTarget(
  target: OptionalAutomationTarget | null | undefined,
): target is AutomationTarget {
  return Boolean(target?.provider && target?.targetKind && target?.externalRef);
}

/**
 * Merged-PR scan resume cursor stored in automations.scan_cursor
 * (security_auditor / code_quality_auditor).
 */
export type AutomationScanCursor = {
  mergedAt: string;
  /**
   * `pull_request_facts.id` of the last row in the previous batch: the
   * globally-unique pagination tie-breaker. Absent on cursors written before
   * this field existed; those resume from `mergedAt` alone.
   */
  factId?: string;
  /**
   * Legacy tie-breaker, still written for rolling-deploy compatibility but no
   * longer used to resume: for Bitbucket/ADO it is the per-repository PR
   * number, so same-timestamp rows from different repositories could be
   * skipped forever at a page boundary.
   */
  externalPullRequestId?: number;
};

type ScheduleOnlyBackgroundAutomationDefinition = {
  id: string;
  label: string;
  hashAliases: readonly string[];
  automationKey: BackgroundAutomationKey;
  frequencyField: `${string}Frequency`;
  lastRunAtField: `${string}LastRunAt`;
  scanCursorField: `${string}ScanCursor`;
  defaultFrequency: ScheduleOnlyBackgroundAutomationFrequency;
  requiresManagerChannel: true;
  suggestionSource: string;
};

export const SCHEDULE_ONLY_BACKGROUND_AUTOMATIONS = {
  securityAuditor: {
    id: 'securityAuditor',
    label: 'Security Auditor',
    hashAliases: ['security-auditor', 'securityauditor'],
    automationKey: 'security_auditor',
    frequencyField: 'securityAuditorFrequency',
    lastRunAtField: 'securityAuditorLastRunAt',
    scanCursorField: 'securityAuditorScanCursor',
    defaultFrequency: 'off',
    requiresManagerChannel: true,
    suggestionSource: 'security',
  },
  codeQualityAuditor: {
    id: 'codeQualityAuditor',
    label: 'Code Quality Auditor',
    hashAliases: ['code-quality-auditor', 'codequalityauditor'],
    automationKey: 'code_quality_auditor',
    frequencyField: 'codeQualityAuditorFrequency',
    lastRunAtField: 'codeQualityAuditorLastRunAt',
    scanCursorField: 'codeQualityAuditorScanCursor',
    defaultFrequency: 'off',
    requiresManagerChannel: true,
    suggestionSource: 'code_quality',
  },
  ciFailureTriage: {
    id: 'ciFailureTriage',
    label: 'CI Failure Triage',
    hashAliases: ['ci-failure-triage', 'cifailuretriage'],
    automationKey: 'ci_failure_triage',
    frequencyField: 'ciFailureTriageFrequency',
    lastRunAtField: 'ciFailureTriageLastRunAt',
    scanCursorField: 'ciFailureTriageScanCursor',
    defaultFrequency: 'off',
    requiresManagerChannel: true,
    suggestionSource: 'ci_failure',
  },
  issueFixer: {
    id: 'issueFixer',
    label: 'Triage Issues',
    hashAliases: [
      'issue-fixer',
      'issuefixer',
      'fix-issues',
      'fixissues',
      'triage-issues',
      'triageissues',
      'triage-github-issues',
      'triagegithubissues',
    ],
    automationKey: 'issue_fixer',
    frequencyField: 'issueFixerFrequency',
    lastRunAtField: 'issueFixerLastRunAt',
    scanCursorField: 'issueFixerScanCursor',
    defaultFrequency: 'off',
    requiresManagerChannel: true,
    suggestionSource: 'issue_fixer',
  },
} as const satisfies Record<string, ScheduleOnlyBackgroundAutomationDefinition>;

export type ScheduleOnlyBackgroundAutomationId =
  keyof typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATIONS;
export type ScheduleOnlyBackgroundAutomationMetadata =
  (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATIONS)[ScheduleOnlyBackgroundAutomationId];
export type ScheduleOnlyBackgroundAutomationFrequencyField =
  ScheduleOnlyBackgroundAutomationMetadata['frequencyField'];
export type ScheduleOnlyBackgroundAutomationLastRunAtField =
  ScheduleOnlyBackgroundAutomationMetadata['lastRunAtField'];
export type ScheduleOnlyBackgroundAutomationScanCursorField =
  ScheduleOnlyBackgroundAutomationMetadata['scanCursorField'];
export type ScheduleOnlyBackgroundAutomationSuggestionSource =
  ScheduleOnlyBackgroundAutomationMetadata['suggestionSource'];

export const SCHEDULE_ONLY_BACKGROUND_AUTOMATION_IDS = Object.keys(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATIONS,
) as ScheduleOnlyBackgroundAutomationId[];

export const SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST = Object.values(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATIONS,
) as ScheduleOnlyBackgroundAutomationMetadata[];

const AUTOMATION_KEYS_WITH_HISTORICAL_THREAD_FEEDBACK = [
  'sentry_triage',
  'dependabot_triage',
  'codeql_triage',
  'issue_fixer',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
] as const satisfies readonly BackgroundAutomationKey[];

const AUTOMATION_KEYS_WITH_HISTORICAL_THREAD_FEEDBACK_SET =
  new Set<BackgroundAutomationKey>(
    AUTOMATION_KEYS_WITH_HISTORICAL_THREAD_FEEDBACK,
  );

export function supportsHistoricalThreadFeedback(
  automationKey: BackgroundAutomationKey,
): boolean {
  return AUTOMATION_KEYS_WITH_HISTORICAL_THREAD_FEEDBACK_SET.has(automationKey);
}

export type BackgroundAgentSettingsLike = Record<string, unknown>;

export function getBackgroundAgentFrequencyValues(
  settings: BackgroundAgentSettingsLike,
): string[] {
  return Object.entries(settings).reduce<string[]>((values, [key, value]) => {
    if (key.endsWith('Frequency') && typeof value === 'string') {
      values.push(value);
    }

    return values;
  }, []);
}

export function hasEnabledBackgroundAgents(
  settings: BackgroundAgentSettingsLike,
): boolean {
  return (
    settings.channelAutoStartEnabled === true ||
    getBackgroundAgentFrequencyValues(settings).some((value) => value !== 'off')
  );
}

export type ConflictResolverFrequency =
  | 'off'
  | 'every_hour'
  | 'every_6_hours'
  | 'daily';

export type SuggesterFrequency = 'off' | 'daily' | 'weekly';

export const SUGGESTER_ROUTING_MODES = [
  'manager_channel',
  'group_by_instructions',
] as const;

export type SuggesterRoutingMode = (typeof SUGGESTER_ROUTING_MODES)[number];

export const DEFAULT_SUGGESTER_ROUTING_MODE: SuggesterRoutingMode =
  'manager_channel';

export type AnnouncerFrequency = 'off' | 'daily' | 'weekly';

export type ManagerStatsFrequency = 'off' | 'weekly';

export type SentryTriageFrequency = 'off' | 'daily' | 'weekly';

export type DependabotTriageFrequency = 'off' | 'daily' | 'weekly';
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

export function isSuggesterRoutingMode(
  value: string,
): value is SuggesterRoutingMode {
  return (SUGGESTER_ROUTING_MODES as readonly string[]).includes(value);
}

export function isScheduleOnlyBackgroundAutomationFrequency(
  value: string,
): value is ScheduleOnlyBackgroundAutomationFrequency {
  return (
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES as readonly string[]
  ).includes(value);
}
export type SecurityAuditorFrequency =
  ScheduleOnlyBackgroundAutomationFrequency;

export type CodeQualityAuditorFrequency =
  ScheduleOnlyBackgroundAutomationFrequency;

// CI failure triage is webhook-driven and has no schedule; 'daily' is only
// the stored enabled sentinel so the automation reuses the generic
// schedule-only settings machinery.
export type CiFailureTriageFrequency = 'off' | 'daily';

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
  'slack_channel_auto_start',
  'manager_stats',
  'platform_issue_alerts',
  'sentry_triage',
  'dependabot_triage',
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
  | 'sentry';

export type BackgroundAutomationTargetKind =
  | 'slack_channel'
  | 'teams_channel'
  | 'telegram_chat'
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
 * Merged-PR scan resume cursor stored in automations.scan_cursor
 * (security_auditor / code_quality_auditor).
 */
export type AutomationScanCursor = {
  mergedAt: string;
  externalPullRequestId: number;
};

export type BackgroundAutomationAvailability = 'stable' | 'beta';

type ScheduleOnlyBackgroundAutomationDefinition = {
  id: string;
  label: string;
  hashAliases: readonly string[];
  availability: BackgroundAutomationAvailability;
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
    availability: 'stable',
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
    availability: 'stable',
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
    availability: 'stable',
    automationKey: 'ci_failure_triage',
    frequencyField: 'ciFailureTriageFrequency',
    lastRunAtField: 'ciFailureTriageLastRunAt',
    scanCursorField: 'ciFailureTriageScanCursor',
    defaultFrequency: 'off',
    requiresManagerChannel: true,
    suggestionSource: 'ci_failure',
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

export const BETA_BACKGROUND_AUTOMATION_KEYS = [
  'sentry_triage',
  'dependabot_triage',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
] as const satisfies readonly BackgroundAutomationKey[];

export type BetaBackgroundAutomationKey =
  (typeof BETA_BACKGROUND_AUTOMATION_KEYS)[number];

const BETA_BACKGROUND_AUTOMATION_KEY_SET = new Set<BackgroundAutomationKey>(
  BETA_BACKGROUND_AUTOMATION_KEYS,
);

export function isBetaBackgroundAutomationKey(
  automationKey: BackgroundAutomationKey,
): automationKey is BetaBackgroundAutomationKey {
  return BETA_BACKGROUND_AUTOMATION_KEY_SET.has(automationKey);
}

export function getBackgroundAutomationAvailability(
  automationKey: BackgroundAutomationKey,
): BackgroundAutomationAvailability {
  return isBetaBackgroundAutomationKey(automationKey) ? 'beta' : 'stable';
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

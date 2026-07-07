import type {
  AnnouncerFrequency,
  BackgroundAutomationAvailability,
  BackgroundAutomationKey,
  CiFailureTriageFrequency,
  CodeQualityAuditorFrequency,
  ConflictResolverFrequency,
  DependabotTriageFrequency,
  ManagerStatsFrequency,
  SecurityAuditorFrequency,
  SentryTriageFrequency,
  SuggesterFrequency,
} from './background-agents';
import type { TaskSuggestionSource } from './cloud-jobs';

export const AUTO_RESPOND_CHANNELS_SETTINGS_HASH = 'auto-respond-channels';
export const MANAGER_CHANNEL_SETTINGS_HASH = 'roomote-managers';
export const MANAGER_STATS_SETTINGS_HASH = 'weekly-manager-stats';
export const SUGGEST_IDEAS_SETTINGS_HASH = 'suggest-ideas';
export const SUGGEST_SELF_IMPROVEMENTS_SETTINGS_HASH =
  'suggest-self-improvements';
export const SENTRY_TRIAGE_SETTINGS_HASH = 'sentry-triage';
export const DEPENDABOT_TRIAGE_SETTINGS_HASH = 'dependabot-triage';
export const SECURITY_AUDITOR_SETTINGS_HASH = 'security-auditor';
export const CODE_QUALITY_AUDITOR_SETTINGS_HASH = 'code-quality-auditor';
export const CI_FAILURE_TRIAGE_SETTINGS_HASH = 'ci-failure-triage';
export const SUMMARIZE_MERGED_PRS_SETTINGS_HASH = 'summarize-merged-prs';

export type BackgroundAutomationSettingsHash =
  | typeof AUTO_RESPOND_CHANNELS_SETTINGS_HASH
  | typeof MANAGER_CHANNEL_SETTINGS_HASH
  | typeof MANAGER_STATS_SETTINGS_HASH
  | typeof SUGGEST_IDEAS_SETTINGS_HASH
  | typeof SUGGEST_SELF_IMPROVEMENTS_SETTINGS_HASH
  | typeof SENTRY_TRIAGE_SETTINGS_HASH
  | typeof DEPENDABOT_TRIAGE_SETTINGS_HASH
  | typeof SECURITY_AUDITOR_SETTINGS_HASH
  | typeof CODE_QUALITY_AUDITOR_SETTINGS_HASH
  | typeof CI_FAILURE_TRIAGE_SETTINGS_HASH
  | typeof SUMMARIZE_MERGED_PRS_SETTINGS_HASH;

export type BackgroundAutomationManualTriggerRequirement =
  | 'slack'
  | 'github'
  | 'repository'
  | 'sentry';

export type BackgroundAutomationManagerChannelKind =
  | 'suggester'
  | 'announcer'
  | 'managerStats'
  | 'sentryTriage'
  | 'dependabotTriage'
  | 'securityAuditor'
  | 'codeQualityAuditor'
  | 'ciFailureTriage';

export type BackgroundAutomationScheduleField =
  | 'conflictResolverFrequency'
  | 'suggesterFrequency'
  | 'announcerFrequency'
  | 'managerStatsFrequency'
  | 'sentryTriageFrequency'
  | 'dependabotTriageFrequency'
  | 'securityAuditorFrequency'
  | 'codeQualityAuditorFrequency'
  | 'ciFailureTriageFrequency';

export type TriggerableBackgroundAutomationDescriptor<
  TAgentId extends string = string,
  TAutomationKey extends BackgroundAutomationKey = BackgroundAutomationKey,
  TScheduleField extends string = BackgroundAutomationScheduleField,
  TScheduleMode extends string = string,
> = {
  agentId: TAgentId;
  automationKey: TAutomationKey;
  label: string;
  availability: BackgroundAutomationAvailability;
  schedule: {
    field: TScheduleField;
    modes: readonly TScheduleMode[];
  };
  manualTrigger: {
    jobName: string;
    requirements: readonly BackgroundAutomationManualTriggerRequirement[];
  };
  managerChannelKind?: BackgroundAutomationManagerChannelKind;
  scheduledSuggestionSource?: TaskSuggestionSource;
};

const CONFLICT_RESOLVER_SCHEDULE_MODES = [
  'off',
  'every_hour',
  'every_6_hours',
  'daily',
] as const satisfies readonly ConflictResolverFrequency[];

const DAILY_WEEKLY_SCHEDULE_MODES = [
  'off',
  'daily',
  'weekly',
] as const satisfies readonly (
  | SuggesterFrequency
  | AnnouncerFrequency
  | SentryTriageFrequency
  | DependabotTriageFrequency
)[];

// CI failure triage is webhook-driven; 'daily' only means enabled.
const CI_FAILURE_TRIAGE_SCHEDULE_MODES = [
  'off',
  'daily',
] as const satisfies readonly CiFailureTriageFrequency[];

const HOURLY_AUDIT_SCHEDULE_MODES = [
  'off',
  'every_hour',
  'every_6_hours',
  'daily',
  'weekly',
] as const satisfies readonly (
  | SecurityAuditorFrequency
  | CodeQualityAuditorFrequency
)[];

const MANAGER_STATS_SCHEDULE_MODES = [
  'off',
  'weekly',
] as const satisfies readonly ManagerStatsFrequency[];

export const TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS = [
  {
    agentId: 'conflictResolver',
    automationKey: 'conflict_resolver',
    label: 'Resolve PR Conflicts',
    availability: 'stable',
    schedule: {
      field: 'conflictResolverFrequency',
      modes: CONFLICT_RESOLVER_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'ConflictScan',
      requirements: ['github', 'repository'],
    },
  },
  {
    agentId: 'suggester',
    automationKey: 'suggester',
    label: 'Suggest Ideas',
    availability: 'stable',
    schedule: {
      field: 'suggesterFrequency',
      modes: DAILY_WEEKLY_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'Suggester',
      requirements: ['slack', 'github', 'repository'],
    },
    managerChannelKind: 'suggester',
    scheduledSuggestionSource: 'suggest_ideas',
  },
  {
    agentId: 'announcer',
    automationKey: 'announcer',
    label: 'Summarize Merged PRs',
    availability: 'stable',
    schedule: {
      field: 'announcerFrequency',
      modes: DAILY_WEEKLY_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'Announcer',
      requirements: ['slack', 'github'],
    },
    managerChannelKind: 'announcer',
  },
  {
    agentId: 'managerStats',
    automationKey: 'manager_stats',
    label: 'Weekly Manager Stats',
    availability: 'stable',
    schedule: {
      field: 'managerStatsFrequency',
      modes: MANAGER_STATS_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'ManagerStats',
      requirements: ['slack', 'github'],
    },
    managerChannelKind: 'managerStats',
  },
  {
    agentId: 'sentryTriage',
    automationKey: 'sentry_triage',
    label: 'Triage Sentry Issues',
    availability: 'stable',
    schedule: {
      field: 'sentryTriageFrequency',
      modes: DAILY_WEEKLY_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'SentryTriage',
      requirements: ['slack', 'sentry'],
    },
    managerChannelKind: 'sentryTriage',
    scheduledSuggestionSource: 'sentry_triage',
  },
  {
    agentId: 'dependabotTriage',
    automationKey: 'dependabot_triage',
    label: 'Triage Dependabot Alerts',
    availability: 'stable',
    schedule: {
      field: 'dependabotTriageFrequency',
      modes: DAILY_WEEKLY_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'DependabotTriage',
      requirements: ['slack', 'github', 'repository'],
    },
    managerChannelKind: 'dependabotTriage',
    scheduledSuggestionSource: 'dependabot_triage',
  },
  {
    agentId: 'securityAuditor',
    automationKey: 'security_auditor',
    label: 'Security Auditor',
    availability: 'stable',
    schedule: {
      field: 'securityAuditorFrequency',
      modes: HOURLY_AUDIT_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'SecurityAuditor',
      requirements: ['slack', 'github', 'repository'],
    },
    managerChannelKind: 'securityAuditor',
    scheduledSuggestionSource: 'security_auditor',
  },
  {
    agentId: 'codeQualityAuditor',
    automationKey: 'code_quality_auditor',
    label: 'Code Quality Auditor',
    availability: 'stable',
    schedule: {
      field: 'codeQualityAuditorFrequency',
      modes: HOURLY_AUDIT_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'CodeQualityAuditor',
      requirements: ['slack', 'github', 'repository'],
    },
    managerChannelKind: 'codeQualityAuditor',
    scheduledSuggestionSource: 'code_quality_auditor',
  },
  {
    agentId: 'ciFailureTriage',
    automationKey: 'ci_failure_triage',
    label: 'CI Failure Triage',
    availability: 'stable',
    schedule: {
      field: 'ciFailureTriageFrequency',
      modes: CI_FAILURE_TRIAGE_SCHEDULE_MODES,
    },
    manualTrigger: {
      jobName: 'CiFailureTriage',
      requirements: ['slack', 'github', 'repository'],
    },
    managerChannelKind: 'ciFailureTriage',
    scheduledSuggestionSource: 'ci_failure_triage',
  },
] as const satisfies readonly TriggerableBackgroundAutomationDescriptor[];

export type TriggerableBackgroundAutomationDescriptorItem =
  (typeof TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS)[number];

export type TriggerableBackgroundAutomationAgentId =
  TriggerableBackgroundAutomationDescriptorItem['agentId'];

type BackgroundAutomationSettingsCatalogEntry =
  | {
      hash: BackgroundAutomationSettingsHash;
      label: string;
      agentId?: never;
    }
  | {
      hash: BackgroundAutomationSettingsHash;
      label?: never;
      agentId: TriggerableBackgroundAutomationAgentId;
    };

export type BackgroundAutomationSettingsDescriptor = {
  hash: BackgroundAutomationSettingsHash;
  label: string;
  agentId?: TriggerableBackgroundAutomationAgentId;
};

function hasScheduledSuggestionSource(
  descriptor: TriggerableBackgroundAutomationDescriptorItem,
): descriptor is TriggerableBackgroundAutomationDescriptorItem & {
  scheduledSuggestionSource: TaskSuggestionSource;
} {
  return 'scheduledSuggestionSource' in descriptor;
}

function hasSettingsAgentId(
  entry: BackgroundAutomationSettingsCatalogEntry,
): entry is Extract<
  BackgroundAutomationSettingsCatalogEntry,
  { agentId: TriggerableBackgroundAutomationAgentId }
> {
  return 'agentId' in entry;
}

export function hasTriggerableBackgroundAutomationManagerChannelKind(
  descriptor: TriggerableBackgroundAutomationDescriptorItem,
): descriptor is TriggerableBackgroundAutomationDescriptorItem & {
  managerChannelKind: BackgroundAutomationManagerChannelKind;
} {
  return 'managerChannelKind' in descriptor;
}

const BACKGROUND_AUTOMATION_SETTINGS_CATALOG = [
  {
    hash: AUTO_RESPOND_CHANNELS_SETTINGS_HASH,
    label: 'Auto-respond to Slack channels',
  },
  {
    hash: MANAGER_CHANNEL_SETTINGS_HASH,
    label: 'Manager Channel',
  },
  {
    hash: MANAGER_STATS_SETTINGS_HASH,
    agentId: 'managerStats',
  },
  {
    hash: SUGGEST_IDEAS_SETTINGS_HASH,
    agentId: 'suggester',
  },
  {
    hash: SUGGEST_SELF_IMPROVEMENTS_SETTINGS_HASH,
    label: 'Suggest Self-improvements',
  },
  {
    hash: SENTRY_TRIAGE_SETTINGS_HASH,
    agentId: 'sentryTriage',
  },
  {
    hash: DEPENDABOT_TRIAGE_SETTINGS_HASH,
    agentId: 'dependabotTriage',
  },
  {
    hash: SECURITY_AUDITOR_SETTINGS_HASH,
    agentId: 'securityAuditor',
  },
  {
    hash: CODE_QUALITY_AUDITOR_SETTINGS_HASH,
    agentId: 'codeQualityAuditor',
  },
  {
    hash: CI_FAILURE_TRIAGE_SETTINGS_HASH,
    agentId: 'ciFailureTriage',
  },
  {
    hash: SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
    agentId: 'announcer',
  },
] as const satisfies readonly BackgroundAutomationSettingsCatalogEntry[];

const TRIGGERABLE_BACKGROUND_AUTOMATION_AGENT_ID_SET = new Set<string>(
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.map(
    (descriptor) => descriptor.agentId,
  ),
);

const TRIGGERABLE_BACKGROUND_AUTOMATION_BY_AGENT_ID: ReadonlyMap<
  TriggerableBackgroundAutomationAgentId,
  TriggerableBackgroundAutomationDescriptorItem
> = new Map(
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.map((descriptor) => [
    descriptor.agentId,
    descriptor,
  ]),
);

const TRIGGERABLE_BACKGROUND_AUTOMATION_BY_KEY: ReadonlyMap<
  BackgroundAutomationKey,
  TriggerableBackgroundAutomationDescriptorItem
> = new Map(
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.map((descriptor) => [
    descriptor.automationKey,
    descriptor,
  ]),
);

const SCHEDULED_SUGGESTION_BACKGROUND_AUTOMATION_BY_SOURCE: ReadonlyMap<
  TaskSuggestionSource,
  TriggerableBackgroundAutomationDescriptorItem
> = new Map(
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.flatMap((descriptor) =>
    hasScheduledSuggestionSource(descriptor)
      ? [[descriptor.scheduledSuggestionSource, descriptor] as const]
      : [],
  ),
);

const BACKGROUND_AUTOMATION_SETTINGS_BY_HASH: ReadonlyMap<
  BackgroundAutomationSettingsHash,
  BackgroundAutomationSettingsCatalogEntry
> = new Map(
  BACKGROUND_AUTOMATION_SETTINGS_CATALOG.map((entry) => [entry.hash, entry]),
);

const TRIGGERABLE_BACKGROUND_AUTOMATION_SETTINGS_HASH_BY_AGENT_ID: ReadonlyMap<
  TriggerableBackgroundAutomationAgentId,
  BackgroundAutomationSettingsHash
> = new Map(
  BACKGROUND_AUTOMATION_SETTINGS_CATALOG.flatMap((entry) =>
    hasSettingsAgentId(entry) ? [[entry.agentId, entry.hash] as const] : [],
  ),
);

export const SHARED_MANAGER_CHANNEL_ONLY_KINDS = [
  'managerStats',
  'sentryTriage',
  'dependabotTriage',
  'securityAuditor',
  'codeQualityAuditor',
  'ciFailureTriage',
] as const satisfies readonly BackgroundAutomationManagerChannelKind[];

const SHARED_MANAGER_CHANNEL_ONLY_KIND_SET = new Set<string>(
  SHARED_MANAGER_CHANNEL_ONLY_KINDS,
);

export function isTriggerableBackgroundAutomationAgentId(
  value: string,
): value is TriggerableBackgroundAutomationAgentId {
  return TRIGGERABLE_BACKGROUND_AUTOMATION_AGENT_ID_SET.has(value);
}

export function getTriggerableBackgroundAutomationDescriptor(
  agentId: TriggerableBackgroundAutomationAgentId,
): TriggerableBackgroundAutomationDescriptorItem | null {
  return TRIGGERABLE_BACKGROUND_AUTOMATION_BY_AGENT_ID.get(agentId) ?? null;
}

export function getTriggerableBackgroundAutomationDescriptorByKey(
  automationKey: BackgroundAutomationKey,
): TriggerableBackgroundAutomationDescriptorItem | null {
  return TRIGGERABLE_BACKGROUND_AUTOMATION_BY_KEY.get(automationKey) ?? null;
}

export function getScheduledSuggestionBackgroundAutomationDescriptor(
  source?: TaskSuggestionSource,
): TriggerableBackgroundAutomationDescriptorItem | null {
  return (
    (source
      ? SCHEDULED_SUGGESTION_BACKGROUND_AUTOMATION_BY_SOURCE.get(source)
      : null) ?? getTriggerableBackgroundAutomationDescriptor('suggester')
  );
}

export function getTriggerableBackgroundAutomationSettingsHash(
  agentId: TriggerableBackgroundAutomationAgentId,
): BackgroundAutomationSettingsHash | null {
  return (
    TRIGGERABLE_BACKGROUND_AUTOMATION_SETTINGS_HASH_BY_AGENT_ID.get(agentId) ??
    null
  );
}

export function getBackgroundAutomationSettingsDescriptor(
  hash: string,
): BackgroundAutomationSettingsDescriptor | null {
  const entry = BACKGROUND_AUTOMATION_SETTINGS_BY_HASH.get(
    hash as BackgroundAutomationSettingsHash,
  );

  if (!entry) {
    return null;
  }

  if (hasSettingsAgentId(entry)) {
    const descriptor = getTriggerableBackgroundAutomationDescriptor(
      entry.agentId,
    );

    if (!descriptor) {
      throw new Error(
        `Missing triggerable background automation descriptor for ${entry.agentId}.`,
      );
    }

    return {
      hash: entry.hash,
      label: descriptor.label,
      agentId: entry.agentId,
    };
  }

  return {
    hash: entry.hash,
    label: entry.label,
  };
}

export function isSharedManagerChannelOnlyKind(
  kind: BackgroundAutomationManagerChannelKind,
) {
  return SHARED_MANAGER_CHANNEL_ONLY_KIND_SET.has(kind);
}

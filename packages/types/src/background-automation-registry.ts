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
import type { CommunicationProvider } from './communication';
import { sourceControlProviders } from './source-control';
import type { SourceControlProvider } from './source-control';
import type { TaskSuggestionSource } from './task-runs';

export const AUTO_RESPOND_CHANNELS_SETTINGS_HASH = 'auto-respond-channels';
export const MANAGER_CHANNEL_SETTINGS_HASH = 'roomote-managers';
export const MANAGER_STATS_SETTINGS_HASH = 'weekly-manager-stats';
export const SUGGEST_IDEAS_SETTINGS_HASH = 'suggest-ideas';
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

/**
 * Descriptor for an automation that can be manually triggered ("Run now")
 * and scheduled from the Automations settings page. Keyed exclusively by the
 * canonical snake_case automation key.
 */
export type TriggerableBackgroundAutomationDescriptor<
  TAutomationKey extends BackgroundAutomationKey = BackgroundAutomationKey,
  TScheduleMode extends string = string,
> = {
  automationKey: TAutomationKey;
  label: string;
  availability: BackgroundAutomationAvailability;
  scheduleModes: readonly TScheduleMode[];
  manualTriggerRequirements: readonly BackgroundAutomationManualTriggerRequirement[];
  /** Whether the automation posts to the shared manager channel by default. */
  usesManagerChannel: boolean;
  /**
   * Comms surfaces the automation's shipped runner can report to today.
   * Empty for automations that report elsewhere (e.g. PR comments). Expanded
   * per-automation as runners generalize; settings gating and the automations
   * page read this as the source of truth.
   */
  supportedCommunicationProviders: readonly CommunicationProvider[];
  /**
   * Source-control providers the automation's shipped runner works with
   * today. Inherently-GitHub automations (Dependabot, GitHub Actions CI
   * triage) stay ['github'] by design; others expand as their gates and
   * scans go provider-neutral.
   */
  supportedSourceControlProviders: readonly SourceControlProvider[];
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
    automationKey: 'conflict_resolver',
    label: 'Resolve PR Conflicts',
    availability: 'stable',
    scheduleModes: CONFLICT_RESOLVER_SCHEDULE_MODES,
    // Provider-neutral scan: any active repository qualifies, GitHub
    // installation no longer required.
    manualTriggerRequirements: ['repository'],
    usesManagerChannel: false,
    supportedCommunicationProviders: [],
    supportedSourceControlProviders: ['github', 'gitlab', 'ado'],
  },
  {
    automationKey: 'suggester',
    label: 'Suggest Ideas',
    availability: 'stable',
    scheduleModes: DAILY_WEEKLY_SCHEDULE_MODES,
    // Provider-agnostic: suggestion scans work with any synced repository.
    manualTriggerRequirements: ['slack', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack'],
    supportedSourceControlProviders: sourceControlProviders,
    scheduledSuggestionSource: 'suggest_ideas',
  },
  {
    automationKey: 'announcer',
    label: 'Summarize Merged PRs',
    availability: 'stable',
    scheduleModes: DAILY_WEEKLY_SCHEDULE_MODES,
    // Merged-PR summaries read the provider-neutral taskPullRequests table.
    manualTriggerRequirements: ['slack', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: sourceControlProviders,
  },
  {
    automationKey: 'manager_stats',
    label: 'Weekly Manager Stats',
    availability: 'stable',
    scheduleModes: MANAGER_STATS_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'github'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: ['github'],
  },
  {
    automationKey: 'sentry_triage',
    label: 'Triage Sentry Issues',
    availability: 'stable',
    scheduleModes: DAILY_WEEKLY_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'sentry'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: sourceControlProviders,
    scheduledSuggestionSource: 'sentry_triage',
  },
  {
    automationKey: 'dependabot_triage',
    label: 'Triage Dependabot Alerts',
    availability: 'stable',
    scheduleModes: DAILY_WEEKLY_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'github', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: ['github'],
    scheduledSuggestionSource: 'dependabot_triage',
  },
  {
    automationKey: 'security_auditor',
    label: 'Security Auditor',
    availability: 'stable',
    scheduleModes: HOURLY_AUDIT_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'github', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: ['github'],
    scheduledSuggestionSource: 'security_auditor',
  },
  {
    automationKey: 'code_quality_auditor',
    label: 'Code Quality Auditor',
    availability: 'stable',
    scheduleModes: HOURLY_AUDIT_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'github', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack', 'teams', 'telegram'],
    supportedSourceControlProviders: ['github'],
    scheduledSuggestionSource: 'code_quality_auditor',
  },
  {
    automationKey: 'ci_failure_triage',
    label: 'CI Failure Triage',
    availability: 'stable',
    scheduleModes: CI_FAILURE_TRIAGE_SCHEDULE_MODES,
    manualTriggerRequirements: ['slack', 'github', 'repository'],
    usesManagerChannel: true,
    supportedCommunicationProviders: ['slack'],
    supportedSourceControlProviders: ['github'],
    scheduledSuggestionSource: 'ci_failure_triage',
  },
] as const satisfies readonly TriggerableBackgroundAutomationDescriptor[];

export type TriggerableBackgroundAutomationDescriptorItem =
  (typeof TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS)[number];

export type TriggerableBackgroundAutomationKey =
  TriggerableBackgroundAutomationDescriptorItem['automationKey'];

type BackgroundAutomationSettingsCatalogEntry =
  | {
      hash: BackgroundAutomationSettingsHash;
      label: string;
      automationKey?: never;
    }
  | {
      hash: BackgroundAutomationSettingsHash;
      label?: never;
      automationKey: TriggerableBackgroundAutomationKey;
    };

export type BackgroundAutomationSettingsDescriptor = {
  hash: BackgroundAutomationSettingsHash;
  label: string;
  automationKey?: TriggerableBackgroundAutomationKey;
};

function hasScheduledSuggestionSource(
  descriptor: TriggerableBackgroundAutomationDescriptorItem,
): descriptor is TriggerableBackgroundAutomationDescriptorItem & {
  scheduledSuggestionSource: TaskSuggestionSource;
} {
  return 'scheduledSuggestionSource' in descriptor;
}

function hasSettingsAutomationKey(
  entry: BackgroundAutomationSettingsCatalogEntry,
): entry is Extract<
  BackgroundAutomationSettingsCatalogEntry,
  { automationKey: TriggerableBackgroundAutomationKey }
> {
  return 'automationKey' in entry;
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
    automationKey: 'manager_stats',
  },
  {
    hash: SUGGEST_IDEAS_SETTINGS_HASH,
    automationKey: 'suggester',
  },
  {
    hash: SENTRY_TRIAGE_SETTINGS_HASH,
    automationKey: 'sentry_triage',
  },
  {
    hash: DEPENDABOT_TRIAGE_SETTINGS_HASH,
    automationKey: 'dependabot_triage',
  },
  {
    hash: SECURITY_AUDITOR_SETTINGS_HASH,
    automationKey: 'security_auditor',
  },
  {
    hash: CODE_QUALITY_AUDITOR_SETTINGS_HASH,
    automationKey: 'code_quality_auditor',
  },
  {
    hash: CI_FAILURE_TRIAGE_SETTINGS_HASH,
    automationKey: 'ci_failure_triage',
  },
  {
    hash: SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
    automationKey: 'announcer',
  },
] as const satisfies readonly BackgroundAutomationSettingsCatalogEntry[];

const TRIGGERABLE_BACKGROUND_AUTOMATION_KEY_SET = new Set<string>(
  TRIGGERABLE_BACKGROUND_AUTOMATION_DESCRIPTORS.map(
    (descriptor) => descriptor.automationKey,
  ),
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

const TRIGGERABLE_BACKGROUND_AUTOMATION_SETTINGS_HASH_BY_KEY: ReadonlyMap<
  TriggerableBackgroundAutomationKey,
  BackgroundAutomationSettingsHash
> = new Map(
  BACKGROUND_AUTOMATION_SETTINGS_CATALOG.flatMap((entry) =>
    hasSettingsAutomationKey(entry)
      ? [[entry.automationKey, entry.hash] as const]
      : [],
  ),
);

export function isTriggerableBackgroundAutomationKey(
  value: string,
): value is TriggerableBackgroundAutomationKey {
  return TRIGGERABLE_BACKGROUND_AUTOMATION_KEY_SET.has(value);
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
      : null) ?? getTriggerableBackgroundAutomationDescriptorByKey('suggester')
  );
}

export function getTriggerableBackgroundAutomationSettingsHash(
  automationKey: TriggerableBackgroundAutomationKey,
): BackgroundAutomationSettingsHash | null {
  return (
    TRIGGERABLE_BACKGROUND_AUTOMATION_SETTINGS_HASH_BY_KEY.get(automationKey) ??
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

  if (hasSettingsAutomationKey(entry)) {
    const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
      entry.automationKey,
    );

    if (!descriptor) {
      throw new Error(
        `Missing triggerable background automation descriptor for ${entry.automationKey}.`,
      );
    }

    return {
      hash: entry.hash,
      label: descriptor.label,
      automationKey: entry.automationKey,
    };
  }

  return {
    hash: entry.hash,
    label: entry.label,
  };
}

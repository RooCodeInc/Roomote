import type {
  BackgroundAutomationKey,
  BackgroundAutomationTargetKind,
} from './background-agents';

/**
 * Shared form/API destination field pairs for automations that expose a
 * one-of Slack-or-Discord destination picker on the Automations settings page.
 *
 * `automations.targets` remains the canonical store; these descriptors drive
 * flattened settings projection, form dirty/save maps, channel resolution, and
 * upsert target management so each new automation is a registry entry rather
 * than another hand-rolled field quartet.
 */
export type AutomationDestinationAutomationId =
  | 'managerStats'
  | 'sentryTriage'
  | 'dependabotTriage'
  | 'codeqlTriage'
  | 'securityAuditor'
  | 'codeQualityAuditor'
  | 'ciFailureTriage'
  | 'suggester'
  | 'announcer'
  | 'platformIssueAlerts';

export type AutomationDestinationDescriptor = {
  automationId: AutomationDestinationAutomationId;
  automationKey: BackgroundAutomationKey;
  /** Form + settings-update API field for the Slack destination display/input. */
  slackField: `${string}SlackChannel`;
  /** Form + settings-update API field for the Discord destination. */
  discordField: `${string}DiscordChannel`;
  /** Flattened BackgroundAgentSettings key for the resolved Slack channel id. */
  slackSettingsKey: `${string}SlackChannelId`;
  /** Flattened BackgroundAgentSettings key for the Discord channel id. */
  discordSettingsKey: `${string}DiscordChannelId`;
  /**
   * Soft-read Slack id includes the shared manager-channel fallback. When
   * keep-persisting an automation that already has a Discord destination,
   * drop that fallback Slack id so it is not written back as an own target
   * that would override Discord.
   */
  slackSettingsIncludesManagerFallback: boolean;
  /**
   * Discord form field is optional on the API for deploy compatibility: an
   * older client that never sends it must preserve the persisted Discord
   * target unless it explicitly selected a Slack channel (a destination
   * choice that must clear Discord).
   */
  optionalDiscordInput: boolean;
  /**
   * Target kinds managed on save for this destination picker. Combined with
   * only the selected provider's channel, this clears the other provider.
   */
  managedTargetKinds: readonly BackgroundAutomationTargetKind[];
};

export const AUTOMATION_DESTINATION_DESCRIPTORS = [
  {
    automationId: 'managerStats',
    automationKey: 'manager_stats',
    slackField: 'managerStatsSlackChannel',
    discordField: 'managerStatsDiscordChannel',
    slackSettingsKey: 'managerStatsSlackChannelId',
    discordSettingsKey: 'managerStatsDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'sentryTriage',
    automationKey: 'sentry_triage',
    slackField: 'sentryTriageSlackChannel',
    discordField: 'sentryTriageDiscordChannel',
    slackSettingsKey: 'sentryTriageSlackChannelId',
    discordSettingsKey: 'sentryTriageDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'sentry_project'],
  },
  {
    automationId: 'dependabotTriage',
    automationKey: 'dependabot_triage',
    slackField: 'dependabotTriageSlackChannel',
    discordField: 'dependabotTriageDiscordChannel',
    slackSettingsKey: 'dependabotTriageSlackChannelId',
    discordSettingsKey: 'dependabotTriageDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'codeqlTriage',
    automationKey: 'codeql_triage',
    slackField: 'codeqlTriageSlackChannel',
    discordField: 'codeqlTriageDiscordChannel',
    slackSettingsKey: 'codeqlTriageSlackChannelId',
    discordSettingsKey: 'codeqlTriageDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'securityAuditor',
    automationKey: 'security_auditor',
    slackField: 'securityAuditorSlackChannel',
    discordField: 'securityAuditorDiscordChannel',
    slackSettingsKey: 'securityAuditorSlackChannelId',
    discordSettingsKey: 'securityAuditorDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'codeQualityAuditor',
    automationKey: 'code_quality_auditor',
    slackField: 'codeQualityAuditorSlackChannel',
    discordField: 'codeQualityAuditorDiscordChannel',
    slackSettingsKey: 'codeQualityAuditorSlackChannelId',
    discordSettingsKey: 'codeQualityAuditorDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'ciFailureTriage',
    automationKey: 'ci_failure_triage',
    slackField: 'ciFailureTriageSlackChannel',
    discordField: 'ciFailureTriageDiscordChannel',
    slackSettingsKey: 'ciFailureTriageSlackChannelId',
    discordSettingsKey: 'ciFailureTriageDiscordChannelId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'suggester',
    automationKey: 'suggester',
    slackField: 'suggesterSlackChannel',
    discordField: 'suggesterDiscordChannel',
    slackSettingsKey: 'suggesterSlackChannelId',
    discordSettingsKey: 'suggesterDiscordChannelId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'announcer',
    automationKey: 'announcer',
    slackField: 'announcerSlackChannel',
    discordField: 'announcerDiscordChannel',
    slackSettingsKey: 'announcerSlackChannelId',
    discordSettingsKey: 'announcerDiscordChannelId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
  {
    automationId: 'platformIssueAlerts',
    automationKey: 'platform_issue_alerts',
    slackField: 'platformIssueSlackChannel',
    discordField: 'platformIssueDiscordChannel',
    slackSettingsKey: 'platformIssueSlackChannelId',
    discordSettingsKey: 'platformIssueDiscordChannelId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel'],
  },
] as const satisfies readonly AutomationDestinationDescriptor[];

export type AutomationDestinationDescriptorItem =
  (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number];

export type AutomationDestinationSlackField =
  AutomationDestinationDescriptorItem['slackField'];

export type AutomationDestinationDiscordField =
  AutomationDestinationDescriptorItem['discordField'];

export type AutomationDestinationSlackSettingsKey =
  AutomationDestinationDescriptorItem['slackSettingsKey'];

export type AutomationDestinationDiscordSettingsKey =
  AutomationDestinationDescriptorItem['discordSettingsKey'];

const AUTOMATION_DESTINATION_BY_ID = new Map<
  string,
  AutomationDestinationDescriptorItem
>(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.automationId,
    descriptor,
  ]),
);

const AUTOMATION_DESTINATION_BY_KEY = new Map<
  string,
  AutomationDestinationDescriptorItem
>(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.automationKey,
    descriptor,
  ]),
);

const AUTOMATION_DESTINATION_BY_SLACK_FIELD = new Map<
  string,
  AutomationDestinationDescriptorItem
>(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.slackField,
    descriptor,
  ]),
);

export function getAutomationDestinationDescriptorById(
  automationId: string,
): AutomationDestinationDescriptorItem | null {
  return AUTOMATION_DESTINATION_BY_ID.get(automationId) ?? null;
}

export function getAutomationDestinationDescriptorByKey(
  automationKey: BackgroundAutomationKey,
): AutomationDestinationDescriptorItem | null {
  return AUTOMATION_DESTINATION_BY_KEY.get(automationKey) ?? null;
}

export function getAutomationDestinationDescriptorBySlackField(
  slackField: string,
): AutomationDestinationDescriptorItem | null {
  return AUTOMATION_DESTINATION_BY_SLACK_FIELD.get(slackField) ?? null;
}

export function isAutomationDestinationAutomationId(
  value: string,
): value is AutomationDestinationAutomationId {
  return AUTOMATION_DESTINATION_BY_ID.has(value);
}

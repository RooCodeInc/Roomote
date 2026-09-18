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
  | 'providerUsageLimit'
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
  /** Form + settings-update API field for the Email destination identity. */
  emailField: `${string}EmailIdentityId`;
  /** Flattened BackgroundAgentSettings key for the resolved Slack channel id. */
  slackSettingsKey: `${string}SlackChannelId`;
  /** Flattened BackgroundAgentSettings key for the Discord channel id. */
  discordSettingsKey: `${string}DiscordChannelId`;
  /** Flattened BackgroundAgentSettings key for the selected Email identity. */
  emailSettingsKey: `${string}EmailIdentityId`;
  /** Flattened BackgroundAgentSettings key for the Email recipient user. */
  emailUserSettingsKey: `${string}EmailUserId`;
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
    emailField: 'managerStatsEmailIdentityId',
    slackSettingsKey: 'managerStatsSlackChannelId',
    discordSettingsKey: 'managerStatsDiscordChannelId',
    emailSettingsKey: 'managerStatsEmailIdentityId',
    emailUserSettingsKey: 'managerStatsEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'providerUsageLimit',
    automationKey: 'provider_usage_limit',
    slackField: 'providerUsageLimitSlackChannel',
    discordField: 'providerUsageLimitDiscordChannel',
    emailField: 'providerUsageLimitEmailIdentityId',
    slackSettingsKey: 'providerUsageLimitSlackChannelId',
    discordSettingsKey: 'providerUsageLimitDiscordChannelId',
    emailSettingsKey: 'providerUsageLimitEmailIdentityId',
    emailUserSettingsKey: 'providerUsageLimitEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'sentryTriage',
    automationKey: 'sentry_triage',
    slackField: 'sentryTriageSlackChannel',
    discordField: 'sentryTriageDiscordChannel',
    emailField: 'sentryTriageEmailIdentityId',
    slackSettingsKey: 'sentryTriageSlackChannelId',
    discordSettingsKey: 'sentryTriageDiscordChannelId',
    emailSettingsKey: 'sentryTriageEmailIdentityId',
    emailUserSettingsKey: 'sentryTriageEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: [
      'slack_channel',
      'discord_channel',
      'email_user',
      'sentry_project',
    ],
  },
  {
    automationId: 'dependabotTriage',
    automationKey: 'dependabot_triage',
    slackField: 'dependabotTriageSlackChannel',
    discordField: 'dependabotTriageDiscordChannel',
    emailField: 'dependabotTriageEmailIdentityId',
    slackSettingsKey: 'dependabotTriageSlackChannelId',
    discordSettingsKey: 'dependabotTriageDiscordChannelId',
    emailSettingsKey: 'dependabotTriageEmailIdentityId',
    emailUserSettingsKey: 'dependabotTriageEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'codeqlTriage',
    automationKey: 'codeql_triage',
    slackField: 'codeqlTriageSlackChannel',
    discordField: 'codeqlTriageDiscordChannel',
    emailField: 'codeqlTriageEmailIdentityId',
    slackSettingsKey: 'codeqlTriageSlackChannelId',
    discordSettingsKey: 'codeqlTriageDiscordChannelId',
    emailSettingsKey: 'codeqlTriageEmailIdentityId',
    emailUserSettingsKey: 'codeqlTriageEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'securityAuditor',
    automationKey: 'security_auditor',
    slackField: 'securityAuditorSlackChannel',
    discordField: 'securityAuditorDiscordChannel',
    emailField: 'securityAuditorEmailIdentityId',
    slackSettingsKey: 'securityAuditorSlackChannelId',
    discordSettingsKey: 'securityAuditorDiscordChannelId',
    emailSettingsKey: 'securityAuditorEmailIdentityId',
    emailUserSettingsKey: 'securityAuditorEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'codeQualityAuditor',
    automationKey: 'code_quality_auditor',
    slackField: 'codeQualityAuditorSlackChannel',
    discordField: 'codeQualityAuditorDiscordChannel',
    emailField: 'codeQualityAuditorEmailIdentityId',
    slackSettingsKey: 'codeQualityAuditorSlackChannelId',
    discordSettingsKey: 'codeQualityAuditorDiscordChannelId',
    emailSettingsKey: 'codeQualityAuditorEmailIdentityId',
    emailUserSettingsKey: 'codeQualityAuditorEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'ciFailureTriage',
    automationKey: 'ci_failure_triage',
    slackField: 'ciFailureTriageSlackChannel',
    discordField: 'ciFailureTriageDiscordChannel',
    emailField: 'ciFailureTriageEmailIdentityId',
    slackSettingsKey: 'ciFailureTriageSlackChannelId',
    discordSettingsKey: 'ciFailureTriageDiscordChannelId',
    emailSettingsKey: 'ciFailureTriageEmailIdentityId',
    emailUserSettingsKey: 'ciFailureTriageEmailUserId',
    slackSettingsIncludesManagerFallback: true,
    optionalDiscordInput: false,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'suggester',
    automationKey: 'suggester',
    slackField: 'suggesterSlackChannel',
    discordField: 'suggesterDiscordChannel',
    emailField: 'suggesterEmailIdentityId',
    slackSettingsKey: 'suggesterSlackChannelId',
    discordSettingsKey: 'suggesterDiscordChannelId',
    emailSettingsKey: 'suggesterEmailIdentityId',
    emailUserSettingsKey: 'suggesterEmailUserId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'announcer',
    automationKey: 'announcer',
    slackField: 'announcerSlackChannel',
    discordField: 'announcerDiscordChannel',
    emailField: 'announcerEmailIdentityId',
    slackSettingsKey: 'announcerSlackChannelId',
    discordSettingsKey: 'announcerDiscordChannelId',
    emailSettingsKey: 'announcerEmailIdentityId',
    emailUserSettingsKey: 'announcerEmailUserId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
  {
    automationId: 'platformIssueAlerts',
    automationKey: 'platform_issue_alerts',
    slackField: 'platformIssueSlackChannel',
    discordField: 'platformIssueDiscordChannel',
    emailField: 'platformIssueEmailIdentityId',
    slackSettingsKey: 'platformIssueSlackChannelId',
    discordSettingsKey: 'platformIssueDiscordChannelId',
    emailSettingsKey: 'platformIssueEmailIdentityId',
    emailUserSettingsKey: 'platformIssueEmailUserId',
    slackSettingsIncludesManagerFallback: false,
    optionalDiscordInput: true,
    managedTargetKinds: ['slack_channel', 'discord_channel', 'email_user'],
  },
] as const satisfies readonly AutomationDestinationDescriptor[];

export type AutomationDestinationDescriptorItem =
  (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number];

export type AutomationDestinationSlackField =
  AutomationDestinationDescriptorItem['slackField'];

export type AutomationDestinationDiscordField =
  AutomationDestinationDescriptorItem['discordField'];

export type AutomationDestinationEmailField =
  AutomationDestinationDescriptorItem['emailField'];

export type AutomationDestinationSlackSettingsKey =
  AutomationDestinationDescriptorItem['slackSettingsKey'];

export type AutomationDestinationDiscordSettingsKey =
  AutomationDestinationDescriptorItem['discordSettingsKey'];

export type AutomationDestinationEmailSettingsKey =
  AutomationDestinationDescriptorItem['emailSettingsKey'];

export type AutomationDestinationEmailUserSettingsKey =
  AutomationDestinationDescriptorItem['emailUserSettingsKey'];

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

'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AUTOMATION_DESTINATION_DESCRIPTORS,
  type BackgroundAutomationKey,
  type CommunicationProvider,
  communicationProviders,
  CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  DEFAULT_PROVIDER_USAGE_LIMIT_THRESHOLD,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  getCommunicationProviderDisplayName,
  getSourceControlProviderLabel,
  getTriggerableBackgroundAutomationDescriptorByKey,
  sourceControlProviders,
  type ChannelAutoStartLaunchMode,
  type ConflictResolverMaxPrAgeDays,
  PRODUCT_NAME,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
  type ScheduleOnlyBackgroundAutomationFrequency,
  type ScheduleOnlyBackgroundAutomationFrequencyField,
  type ScheduleOnlyBackgroundAutomationId,
  type SourceControlProvider,
  type TaskState,
  type TaskTrigger,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

import { useConnectSlack } from '@/hooks/slack';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { SETTINGS_PATHS } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

import {
  type AutomationId,
  type AnnouncerFrequency,
  buildAutomationSettingsSaveInput,
  type ChannelAutoStartFormRow,
  type ConflictResolverFrequency,
  type DependabotTriageFrequency,
  type CodeqlTriageFrequency,
  type FormState,
  isAutomationDirty,
  type ManagerStatsFrequency,
  type ProviderUsageLimitFrequency,
  mergeAutomationFields,
  mergeServerStatePreservingDirtySections,
  resetAutomationFields,
  type ReviewerEnvironmentScope,
  type SentryTriageFrequency,
  type SuggesterFrequency,
} from './formState';
import {
  ChannelAutoStartEditor,
  type ChannelAutoStartLaunchModeOption,
  getAvailableAutoRespondChannelTemplates,
} from './ChannelAutoStartEditor';
import {
  ScheduleOnlyAutomationContent,
  SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS,
} from './ScheduleOnlyAutomationContent';
import { CustomAutomationsSection } from './CustomAutomationsSection';
import {
  buildAutomationDiscordDestinationOptions,
  buildManagerSlackChannelOptions,
  DISCORD_DESTINATION_OPTION_PREFIX,
  isManagerChannelSelectionDisabled,
  shouldShowManagerSlackChannelWarning,
  type SlackChannelOption,
} from './channelOptions';
import { ManagerChannelEditor } from './ManagerChannelEditor';
import { SlackChannelSelect } from './SlackChannelSelect';

import {
  Alert,
  AlertCircle,
  AlertDescription,
  AlertTitle,
  BasicTooltip,
  BellElectric,
  BatteryWarning,
  BrandIcon,
  Button,
  Card,
  CardHeader,
  CardTitle,
  ChartColumnIncreasing,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  GitMergeConflict,
  GitPullRequest,
  Info,
  Input,
  Label,
  Lightbulb,
  Megaphone,
  Play,
  Plus,
  RotateCcwClock,
  Search,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Smile,
  MessagesSquare,
  Skeleton,
  Slack,
  Slider,
  Spinner,
  Settings2,
  Switch,
  Textarea,
  TriangleAlert,
  Users,
  X,
} from '@/components/system';

type FieldErrors = Partial<
  Record<
    | 'general'
    | 'reviewerEnvironmentIds'
    | 'reviewerCollaborators'
    | 'reviewerExcludedAuthors'
    | 'conflictResolverLabel'
    | 'conflictResolverMaxPrAgeDays'
    | 'conflictResolverInstructions'
    | 'callRoomoteViaEmojiName'
    | 'callRoomoteViaEmojiInstructions'
    | 'channelAutoStartSlackChannels'
    | 'channelAutoStartDiscordChannels'
    | 'channelAutoStartInstructions'
    | 'managerSlackChannel'
    | 'managerDiscordChannel'
    | 'managerStatsSlackChannel'
    | 'providerUsageLimitSlackChannel'
    | 'suggesterSlackChannel'
    | 'announcerSlackChannel'
    | 'platformIssueSlackChannel'
    | 'sentryTriageSlackChannel'
    | 'dependabotTriageSlackChannel'
    | 'codeqlTriageSlackChannel'
    | 'securityAuditorSlackChannel'
    | 'codeQualityAuditorSlackChannel'
    | 'ciFailureTriageSlackChannel'
    | 'managerStatsDiscordChannel'
    | 'providerUsageLimitDiscordChannel'
    | 'sentryTriageDiscordChannel'
    | 'dependabotTriageDiscordChannel'
    | 'codeqlTriageDiscordChannel'
    | 'securityAuditorDiscordChannel'
    | 'codeQualityAuditorDiscordChannel'
    | 'ciFailureTriageDiscordChannel'
    | 'suggesterDiscordChannel'
    | 'announcerDiscordChannel'
    | 'platformIssueDiscordChannel'
    | 'suggesterUseTelegram'
    | 'suggesterUseTeams'
    | 'sentryTriageProjectSlugs'
    | 'suggesterInstructions'
    | 'announcerInstructions'
    | 'reviewerInstructions'
    | 'issueFixerInstructions',
    string
  >
>;

type SlackChannelAccessWarnings = {
  channelAutoStartSlackChannels: string[];
  managerSlackChannel: string | null;
  managerStatsSlackChannel: string | null;
  providerUsageLimitSlackChannel: string | null;
  suggesterSlackChannel: string | null;
  announcerSlackChannel: string | null;
  platformIssueSlackChannel: string | null;
  sentryTriageSlackChannel: string | null;
  dependabotTriageSlackChannel: string | null;
  codeqlTriageSlackChannel: string | null;
  securityAuditorSlackChannel: string | null;
  codeQualityAuditorSlackChannel: string | null;
  ciFailureTriageSlackChannel: string | null;
};

type AutomationSlackDestinationField =
  (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['slackField'];

const SLACK_DESTINATION_FIELD_AUTOMATION_KEYS = Object.fromEntries(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.slackField,
    descriptor.automationKey,
  ]),
) as {
  [K in AutomationSlackDestinationField]: Extract<
    BackgroundAutomationKey,
    (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['automationKey']
  >;
};

const SLACK_DESTINATION_FIELD_AUTOMATION_IDS = Object.fromEntries(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.slackField,
    descriptor.automationId,
  ]),
) as Record<AutomationSlackDestinationField, AutomationId>;

type AutomationDiscordDestinationField =
  (typeof AUTOMATION_DESTINATION_DESCRIPTORS)[number]['discordField'];

// The form field holding the same automation's Discord destination; the
// destination picker is one-of, so selecting one provider clears the other.
const SLACK_TO_DISCORD_DESTINATION_FIELDS = Object.fromEntries(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.slackField,
    descriptor.discordField,
  ]),
) as Record<AutomationSlackDestinationField, AutomationDiscordDestinationField>;
/** Synthetic option id for Suggest Ideas Telegram sticky-topic destination. */
const TELEGRAM_DESTINATION_OPTION = 'telegram:primary';
const TEAMS_DESTINATION_OPTION = 'teams:primary';

type AutomationDefinition = {
  id: AutomationId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  category: AutomationCategory;
  searchTerms?: string[];
  /** Compact label for the chat surfaces the automation can report to. */
  commsBadge?: string;
  /** Compact label for the source-control providers the automation supports. */
  scmBadge?: string;
};

type AutomationCategory = 'source-code' | 'communication' | 'operations';

const AUTOMATION_CATEGORY_OPTIONS: Array<{
  value: AutomationCategory | 'all';
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'source-code', label: 'Source code' },
  { value: 'communication', label: 'Communication' },
  { value: 'operations', label: 'Operations' },
];

/**
 * Where an automation's next run will report, as resolved server-side through
 * the destination waterfall (own target -> Manager Channel -> primary
 * conversation).
 */
type ResolvedAutomationDestinationSummary = {
  provider: CommunicationProvider;
  channelId: string;
  source: 'automation_target' | 'manager_channel' | 'primary_conversation';
  displayName: string | null;
};

/**
 * A launched-task entry in an automation's run history
 * (tasks.initiator_automation = key).
 */
type AutomationRunSummary = {
  taskId: string;
  title: string | null;
  trigger: TaskTrigger;
  state: TaskState;
  createdAt: Date | string;
  sourceUrl: string | null;
  sourceLabel: string | null;
};

/**
 * lastRunAt/lastError status from the automations row, shown for automations
 * that post directly to Slack instead of launching tasks.
 */
type AutomationStatusSummary = {
  enabled: boolean;
  lastRunAt: Date | string | null;
  lastSucceededAt: Date | string | null;
  lastFailedAt: Date | string | null;
  lastError: string | null;
};

const EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS: SlackChannelAccessWarnings = {
  channelAutoStartSlackChannels: [],
  managerSlackChannel: null,
  managerStatsSlackChannel: null,
  providerUsageLimitSlackChannel: null,
  suggesterSlackChannel: null,
  announcerSlackChannel: null,
  platformIssueSlackChannel: null,
  sentryTriageSlackChannel: null,
  dependabotTriageSlackChannel: null,
  codeqlTriageSlackChannel: null,
  securityAuditorSlackChannel: null,
  codeQualityAuditorSlackChannel: null,
  ciFailureTriageSlackChannel: null,
};

const CHANNEL_AUTO_START_LAUNCH_MODE_OPTIONS: ChannelAutoStartLaunchModeOption[] =
  [
    {
      value: 'always_start',
      label: 'Always start a task',
      description:
        'Best for bug triage channels where every message should launch investigation.',
      instructionsLabel: 'Task instructions (optional)',
      instructionsHint:
        'These instructions are prepended before the Slack message when the task starts.',
      instructionsPlaceholder:
        'Example: Treat each message as a bug report. Reproduce the issue, identify the likely cause, and propose a fix.',
    },
  ];

const TRIGGERABLE_AUTOMATION_DESCRIPTIONS = {
  conflict_resolver: 'Fix merge conflicts in open PRs.',
  suggester: 'Suggest valuable coding work to do.',
  announcer: 'Post a recurring digest of recently merged PRs.',
  manager_stats: "Summary of Roomote's activity during the week",
  provider_usage_limit:
    'Alert when a configured AI provider approaches its usage limit.',
  sentry_triage: 'Scan Sentry issues and post a prioritized triage report.',
  dependabot_triage:
    'Scan open Dependabot alerts and suggest the safest updates.',
  codeql_triage:
    'Scan open CodeQL/code-scanning alerts and launch focused remediation tasks.',
  security_auditor:
    'Review recently merged PRs for concrete security issues and secure-by-default gaps.',
  code_quality_auditor:
    'Review recently merged PRs for maintainability, design, and readability issues worth follow-up work.',
} as const;

const TRIGGERABLE_AUTOMATION_SCHEDULE_LABELS = {
  off: 'Never',
  every_hour: 'Every hour',
  every_15_minutes: 'Every 15 minutes',
  every_6_hours: 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Once a week',
} as const;

/**
 * Exception-only capability badges derived from the automation descriptor:
 * a badge appears only when an automation is LIMITED relative to full
 * provider coverage. Full coverage (or no applicable surface at all) shows
 * nothing — the absence of a warning is the signal.
 */
function getAutomationCapabilityBadges(
  automationKey: BackgroundAutomationKey,
): Pick<AutomationDefinition, 'commsBadge' | 'scmBadge' | 'searchTerms'> {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    return { searchTerms: [] };
  }

  const comms: readonly CommunicationProvider[] =
    descriptor.supportedCommunicationProviders;
  const commsLimited =
    comms.length > 0 && comms.length < communicationProviders.length;
  const commsBadge = commsLimited
    ? comms.length === 1 && comms[0] === 'slack'
      ? 'Slack only'
      : `${comms.map(getCommunicationProviderDisplayName).join(' · ')} only`
    : undefined;

  const scm: readonly SourceControlProvider[] =
    descriptor.supportedSourceControlProviders;
  const scmLimited =
    scm.length > 0 && scm.length < sourceControlProviders.length;
  const scmBadge = scmLimited
    ? scm.length === 1 && scm[0] === 'github'
      ? 'GitHub only'
      : `${scm.map(getSourceControlProviderLabel).join(' · ')} only`
    : undefined;

  return {
    searchTerms: [
      ...comms.map(getCommunicationProviderDisplayName),
      ...scm.map(getSourceControlProviderLabel),
    ],
    ...(commsBadge ? { commsBadge } : {}),
    ...(scmBadge ? { scmBadge } : {}),
  };
}

function getAutomationDefinition(
  automationId: AutomationId,
  automationKey: keyof typeof TRIGGERABLE_AUTOMATION_DESCRIPTIONS,
  icon: ComponentType<{ className?: string }>,
): AutomationDefinition {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    throw new Error(`Missing automation descriptor for ${automationKey}.`);
  }

  return {
    id: automationId,
    label: descriptor.label,
    description: TRIGGERABLE_AUTOMATION_DESCRIPTIONS[automationKey],
    icon,
    category: automationKey === 'sentry_triage' ? 'operations' : 'source-code',
    ...getAutomationCapabilityBadges(automationKey),
  };
}

function DependabotIcon({ className }: { className?: string }) {
  return (
    <BrandIcon icon="dependabot" name="Dependabot" className={className} />
  );
}

function CodeqlIcon({ className }: { className?: string }) {
  return <BrandIcon icon="github" name="CodeQL" className={className} />;
}

function SentryIcon({ className }: { className?: string }) {
  return <BrandIcon icon="sentry" name="Sentry" className={className} />;
}

function getScheduleOptions<TFrequency extends string>(
  automationKey: TriggerableBackgroundAutomationKey,
) {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    throw new Error(`Missing automation descriptor for ${automationKey}.`);
  }

  return descriptor.scheduleModes.map((value) => ({
    value: value as TFrequency,
    label:
      TRIGGERABLE_AUTOMATION_SCHEDULE_LABELS[
        value as keyof typeof TRIGGERABLE_AUTOMATION_SCHEDULE_LABELS
      ],
  }));
}

const CONFLICT_RESOLVER_FREQUENCY_OPTIONS =
  getScheduleOptions<ConflictResolverFrequency>('conflict_resolver');
const CONFLICT_RESOLVER_MAX_PR_AGE_OPTIONS =
  CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS.map((value) => ({
    value,
    label: value === 1 ? '1 day' : `${value} days`,
  }));
const SUGGESTER_FREQUENCY_OPTIONS =
  getScheduleOptions<SuggesterFrequency>('suggester');
const ANNOUNCER_FREQUENCY_OPTIONS =
  getScheduleOptions<AnnouncerFrequency>('announcer');
const SENTRY_TRIAGE_FREQUENCY_OPTIONS =
  getScheduleOptions<SentryTriageFrequency>('sentry_triage');
const SCHEDULE_ONLY_AUTOMATION_FREQUENCY_OPTIONS =
  getScheduleOptions<ScheduleOnlyBackgroundAutomationFrequency>(
    'security_auditor',
  );

const SCHEDULE_ONLY_AUTOMATION_DEFINITIONS = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.id,
    {
      id: automation.id,
      label: automation.label,
      description:
        SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS[automation.id].description,
      icon: SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS[automation.id].icon,
      category: 'source-code',
      ...getAutomationCapabilityBadges(automation.automationKey),
    },
  ]),
) as unknown as Record<
  ScheduleOnlyBackgroundAutomationId,
  AutomationDefinition
>;

const SCHEDULE_ONLY_AUTOMATIONS_BY_ID = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.id,
    automation,
  ]),
) as Record<
  ScheduleOnlyBackgroundAutomationId,
  (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST)[number]
>;

const AUTOMATION_DEFINITIONS: Record<AutomationId, AutomationDefinition> = {
  callRoomoteViaEmoji: {
    id: 'callRoomoteViaEmoji',
    label: 'Call Roomote via emoji',
    description:
      'Start or continue work in a Slack, Discord, or Teams thread by reacting with an emoji.',
    icon: Smile,
    category: 'communication',
    searchTerms: ['Slack', 'Discord', 'Teams'],
  },
  channelAutoStart: {
    id: 'channelAutoStart',
    label: 'Auto-respond to channels',
    description:
      'Start tasks from selected Slack or Discord channels, each with its own custom instructions.',
    icon: MessagesSquare,
    category: 'communication',
    searchTerms: ['Slack', 'Discord'],
  },
  managerChannel: {
    id: 'managerChannel',
    label: 'Automation output',
    description:
      'Shared Slack or Discord channel for manager-facing Roomote asks, summaries, and alerts.',
    icon: Users,
    category: 'communication',
    searchTerms: ['Slack', 'Discord'],
  },
  managerStats: {
    ...getAutomationDefinition(
      'managerStats',
      'manager_stats',
      ChartColumnIncreasing,
    ),
    category: 'communication',
  },
  providerUsageLimit: {
    ...getAutomationDefinition(
      'providerUsageLimit',
      'provider_usage_limit',
      BatteryWarning,
    ),
    category: 'operations',
  },
  sentryTriage: {
    ...getAutomationDefinition('sentryTriage', 'sentry_triage', SentryIcon),
  },
  dependabotTriage: {
    ...getAutomationDefinition(
      'dependabotTriage',
      'dependabot_triage',
      DependabotIcon,
    ),
  },
  codeqlTriage: {
    ...getAutomationDefinition('codeqlTriage', 'codeql_triage', CodeqlIcon),
  },
  ...SCHEDULE_ONLY_AUTOMATION_DEFINITIONS,
  reviewer: {
    id: 'reviewer',
    label: 'Review Code',
    description: `Review PRs automatically and on-demand.`,
    icon: GitPullRequest,
    category: 'source-code',
    searchTerms: sourceControlProviders.map(getSourceControlProviderLabel),
  },
  conflictResolver: {
    ...getAutomationDefinition(
      'conflictResolver',
      'conflict_resolver',
      GitMergeConflict,
    ),
  },
  suggester: {
    ...getAutomationDefinition('suggester', 'suggester', Lightbulb),
    category: 'communication',
  },
  announcer: {
    ...getAutomationDefinition('announcer', 'announcer', Megaphone),
    category: 'communication',
  },
  platformIssueAlerts: {
    id: 'platformIssueAlerts',
    label: 'Alert on Config Errors',
    description:
      'Alert on Slack or Discord when a task runs into admin-fixable issues.',
    icon: BellElectric,
    category: 'operations',
    searchTerms: ['Slack', 'Discord'],
  },
};

const HASH_ALIAS_TO_AUTOMATION_ID: Record<string, AutomationId> = {
  ...Object.fromEntries(
    Object.keys(AUTOMATION_DEFINITIONS).map((automationId) => [
      automationId.toLowerCase(),
      automationId,
    ]),
  ),
  'auto-respond-channels': 'channelAutoStart',
  'call-roomote-via-emoji': 'callRoomoteViaEmoji',
  'emoji-trigger': 'callRoomoteViaEmoji',
  autorespondchannels: 'channelAutoStart',
  'auto-start-tasks': 'channelAutoStart',
  channelautostart: 'channelAutoStart',
  'channel-auto-start': 'channelAutoStart',
  'roomote-managers': 'managerChannel',
  managerchannel: 'managerChannel',
  'manager-channel': 'managerChannel',
  'weekly-manager-stats': 'managerStats',
  managerstats: 'managerStats',
  'provider-usage-limit': 'providerUsageLimit',
  providerusagelimit: 'providerUsageLimit',
  'triage-sentry-issues': 'sentryTriage',
  'sentry-triage': 'sentryTriage',
  sentrytriage: 'sentryTriage',
  'triage-dependabot-alerts': 'dependabotTriage',
  'dependabot-triage': 'dependabotTriage',
  dependabottriage: 'dependabotTriage',
  'triage-codeql-alerts': 'codeqlTriage',
  'codeql-triage': 'codeqlTriage',
  codeqltriage: 'codeqlTriage',
  ...Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.flatMap((automation) =>
      automation.hashAliases.map((hashAlias) => [hashAlias, automation.id]),
    ),
  ),
  'review-code': 'reviewer',
  reviewer: 'reviewer',
  'resolve-pr-conflicts': 'conflictResolver',
  'merge-resolver': 'conflictResolver',
  conflictresolver: 'conflictResolver',
  'suggest-ideas': 'suggester',
  suggester: 'suggester',
  'summarize-merged-prs': 'announcer',
  announcer: 'announcer',
  'alert-on-config-errors': 'platformIssueAlerts',
  'platform-issue-alerts': 'platformIssueAlerts',
};

const AUTOMATION_RUN_KEYS_BY_ID: Partial<
  Record<AutomationId, BackgroundAutomationKey>
> = {
  conflictResolver: 'conflict_resolver',
  suggester: 'suggester',
  announcer: 'announcer',
  managerStats: 'manager_stats',
  providerUsageLimit: 'provider_usage_limit',
  sentryTriage: 'sentry_triage',
  dependabotTriage: 'dependabot_triage',
  codeqlTriage: 'codeql_triage',
  ...Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.id,
      automation.automationKey,
    ]),
  ),
};

const AUTOMATION_HISTORY_KEYS_BY_ID: Partial<
  Record<AutomationId, BackgroundAutomationKey>
> = {
  callRoomoteViaEmoji: 'call_roomote_via_emoji',
  channelAutoStart: 'slack_channel_auto_start',
  reviewer: 'review_code',
  platformIssueAlerts: 'platform_issue_alerts',
  ...AUTOMATION_RUN_KEYS_BY_ID,
};

export function getAutomationHistoryHref(
  automationId: AutomationId,
): string | null {
  // Provider usage alerts are delivered directly to a communication channel;
  // their runner does not create Roomote tasks to inspect.
  if (automationId === 'providerUsageLimit') {
    return null;
  }

  const automationKey = AUTOMATION_HISTORY_KEYS_BY_ID[automationId];
  return automationKey
    ? `/tasks?userId=${encodeURIComponent(`automation:${automationKey}`)}`
    : null;
}

type ScheduleOnlyAutomationFrequencyState = Pick<
  FormState,
  ScheduleOnlyBackgroundAutomationFrequencyField
>;

function mapScheduleOnlyAutomationFormState(
  settings: ScheduleOnlyAutomationFrequencyState,
): ScheduleOnlyAutomationFrequencyState {
  return Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.frequencyField,
      settings[automation.frequencyField],
    ]),
  ) as ScheduleOnlyAutomationFrequencyState;
}

function buildScheduleOnlyAutomationEnabledState(
  formState: ScheduleOnlyAutomationFrequencyState | null | undefined,
): Record<ScheduleOnlyBackgroundAutomationId, boolean> {
  return Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.id,
      (formState?.[automation.frequencyField] ??
        automation.defaultFrequency) !== 'off',
    ]),
  ) as Record<ScheduleOnlyBackgroundAutomationId, boolean>;
}

function buildScheduleOnlyAutomationDirtyState(params: {
  formState: FormState | null;
  savedState: FormState | null;
}): Record<ScheduleOnlyBackgroundAutomationId, boolean> {
  return Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.id,
      params.formState && params.savedState
        ? isAutomationDirty(params.formState, params.savedState, automation.id)
        : false,
    ]),
  ) as Record<ScheduleOnlyBackgroundAutomationId, boolean>;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function getAutomationRunStatusClasses(state: TaskState) {
  switch (state) {
    case 'failed':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'completed':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'active':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
    case 'canceled':
      return 'border-border bg-muted text-muted-foreground';
  }
}

function mapSettingsToFormState(
  settings: {
    reviewer: {
      enabled: boolean;
      environmentScope: ReviewerEnvironmentScope;
      environmentIds: string[];
      reviewAllPullRequestAuthors: boolean;
      reviewOnCommit: boolean;
      reviewDraftPrs: boolean;
      publishGithubCheck: boolean;
      relayReviewResultsToTask: boolean;
      relayUsers: Array<{
        userId: string;
        name: string;
        email: string | null;
        imageUrl: string | null;
        relayEnabled: boolean;
      }>;
    };
    reviewCodeInstructions: string | null;
    callRoomoteViaEmojiEnabled: boolean;
    callRoomoteViaEmojiName: string | null;
    callRoomoteViaEmojiInstructions: string | null;
    conflictResolverFrequency: ConflictResolverFrequency;
    conflictResolverMaxPrAgeDays: ConflictResolverMaxPrAgeDays;
    conflictResolverLabel: string;
    conflictResolverInstructions: string | null;
    channelAutoStartSlackChannels: Array<{
      channelId: string;
      instructions: string | null;
      launchMode?: ChannelAutoStartLaunchMode | null;
      launchCriteria?: string | null;
    }>;
    channelAutoStartDiscordChannels: Array<{
      channelId: string;
      instructions: string | null;
      launchMode?: ChannelAutoStartLaunchMode | null;
      launchCriteria?: string | null;
    }>;
    channelAutoStartSlackChannelNames?: Record<string, string | null>;
    managerSlackChannelId: string | null;
    managerSlackChannelName?: string | null;
    managerDiscordChannelId: string | null;
    managerStatsFrequency: ManagerStatsFrequency;
    managerStatsSlackChannelId: string | null;
    managerStatsSlackChannelName?: string | null;
    managerStatsDiscordChannelId: string | null;
    providerUsageLimitFrequency: ProviderUsageLimitFrequency;
    providerUsageLimitThreshold: number;
    providerUsageLimitSlackChannelId: string | null;
    providerUsageLimitSlackChannelName?: string | null;
    providerUsageLimitDiscordChannelId: string | null;
    sentryTriageFrequency: SentryTriageFrequency;
    sentryTriageSlackChannelId: string | null;
    sentryTriageSlackChannelName?: string | null;
    sentryTriageDiscordChannelId: string | null;
    sentryTriageProjectSlugs: string | null;
    dependabotTriageFrequency: DependabotTriageFrequency;
    dependabotTriageSlackChannelId: string | null;
    dependabotTriageSlackChannelName?: string | null;
    dependabotTriageDiscordChannelId: string | null;
    codeqlTriageFrequency: CodeqlTriageFrequency;
    codeqlTriageSlackChannelId: string | null;
    codeqlTriageSlackChannelName?: string | null;
    codeqlTriageDiscordChannelId: string | null;
    suggesterFrequency: SuggesterFrequency;
    suggesterSlackChannelId: string | null;
    suggesterSlackChannelName?: string | null;
    suggesterDiscordChannelId: string | null;
    suggesterTelegramChatId: string | null;
    suggesterTeamsChannelId: string | null;
    suggesterInstructions: string | null;
    announcerFrequency: AnnouncerFrequency;
    announcerSlackChannelId: string | null;
    announcerSlackChannelName?: string | null;
    announcerDiscordChannelId: string | null;
    announcerInstructions: string | null;
    platformIssueAlertsEnabled: boolean;
    platformIssueSlackChannelId: string | null;
    platformIssueSlackChannelName?: string | null;
    platformIssueDiscordChannelId: string | null;
    securityAuditorSlackChannelId: string | null;
    securityAuditorSlackChannelName?: string | null;
    securityAuditorDiscordChannelId: string | null;
    codeQualityAuditorSlackChannelId: string | null;
    codeQualityAuditorSlackChannelName?: string | null;
    codeQualityAuditorDiscordChannelId: string | null;
    ciFailureTriageSlackChannelId: string | null;
    ciFailureTriageSlackChannelName?: string | null;
    ciFailureTriageDiscordChannelId: string | null;
  } & ScheduleOnlyAutomationFrequencyState & {
      issueFixerInstructions: string | null;
    },
): FormState {
  return {
    callRoomoteViaEmojiEnabled: settings.callRoomoteViaEmojiEnabled,
    callRoomoteViaEmojiName: settings.callRoomoteViaEmojiName ?? '',
    callRoomoteViaEmojiInstructions:
      settings.callRoomoteViaEmojiInstructions ?? '',
    reviewerEnabled: settings.reviewer.enabled,
    reviewerEnvironmentScope: 'all',
    reviewerEnvironmentIds: [],
    reviewerAuthorReviewMode: 'specific',
    reviewerCollaborators: [],
    reviewerExcludedAuthors: '',
    reviewerReviewAllPullRequestAuthors:
      settings.reviewer.reviewAllPullRequestAuthors,
    reviewerReviewOnCommit: settings.reviewer.reviewOnCommit,
    reviewerReviewDraftPrs: settings.reviewer.reviewDraftPrs,
    reviewerPublishGithubCheck: settings.reviewer.publishGithubCheck,
    reviewerInstructions: settings.reviewCodeInstructions ?? '',
    reviewerRelayReviewResultsToTask:
      settings.reviewer.relayReviewResultsToTask,
    reviewerRelayUserIds: settings.reviewer.relayUsers
      .filter((relayUser) => relayUser.relayEnabled)
      .map((relayUser) => relayUser.userId),
    conflictResolverFrequency: settings.conflictResolverFrequency,
    conflictResolverMaxPrAgeDays:
      settings.conflictResolverMaxPrAgeDays ??
      DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
    conflictResolverLabel: settings.conflictResolverLabel,
    conflictResolverInstructions: settings.conflictResolverInstructions ?? '',
    issueFixerInstructions: settings.issueFixerInstructions ?? '',
    channelAutoStartChannels: [
      ...settings.channelAutoStartSlackChannels.map(
        ({ channelId, instructions, launchMode, launchCriteria }) => ({
          provider: 'slack' as const,
          channelId,
          slackChannel:
            settings.channelAutoStartSlackChannelNames?.[channelId] ??
            channelId ??
            '',
          instructions: instructions ?? '',
          launchMode: launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: launchCriteria ?? '',
        }),
      ),
      ...settings.channelAutoStartDiscordChannels.map(
        ({ channelId, instructions, launchMode, launchCriteria }) => ({
          provider: 'discord' as const,
          channelId,
          slackChannel: '',
          instructions: instructions ?? '',
          launchMode: launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: launchCriteria ?? '',
        }),
      ),
    ],
    managerSlackChannel:
      settings.managerSlackChannelName ?? settings.managerSlackChannelId ?? '',
    managerDiscordChannel: settings.managerDiscordChannelId ?? '',
    managerStatsFrequency: settings.managerStatsFrequency,
    managerStatsSlackChannel:
      settings.managerStatsSlackChannelName ??
      settings.managerStatsSlackChannelId ??
      '',
    managerStatsDiscordChannel: settings.managerStatsDiscordChannelId ?? '',
    providerUsageLimitFrequency: settings.providerUsageLimitFrequency,
    providerUsageLimitThreshold:
      settings.providerUsageLimitThreshold ??
      DEFAULT_PROVIDER_USAGE_LIMIT_THRESHOLD,
    providerUsageLimitSlackChannel:
      settings.providerUsageLimitSlackChannelName ??
      settings.providerUsageLimitSlackChannelId ??
      '',
    providerUsageLimitDiscordChannel: '',
    sentryTriageFrequency: settings.sentryTriageFrequency,
    sentryTriageSlackChannel:
      settings.sentryTriageSlackChannelName ??
      settings.sentryTriageSlackChannelId ??
      '',
    sentryTriageDiscordChannel: settings.sentryTriageDiscordChannelId ?? '',
    sentryTriageProjectSlugs: settings.sentryTriageProjectSlugs ?? '',
    dependabotTriageFrequency: settings.dependabotTriageFrequency,
    dependabotTriageSlackChannel:
      settings.dependabotTriageSlackChannelName ??
      settings.dependabotTriageSlackChannelId ??
      '',
    dependabotTriageDiscordChannel:
      settings.dependabotTriageDiscordChannelId ?? '',
    codeqlTriageFrequency: settings.codeqlTriageFrequency,
    codeqlTriageSlackChannel:
      settings.codeqlTriageSlackChannelName ??
      settings.codeqlTriageSlackChannelId ??
      '',
    codeqlTriageDiscordChannel: settings.codeqlTriageDiscordChannelId ?? '',
    ...mapScheduleOnlyAutomationFormState(settings),
    suggesterFrequency: settings.suggesterFrequency,
    suggesterSlackChannel:
      settings.suggesterSlackChannelName ??
      settings.suggesterSlackChannelId ??
      '',
    suggesterDiscordChannel: settings.suggesterDiscordChannelId ?? '',
    suggesterUseTelegram: Boolean(settings.suggesterTelegramChatId),
    suggesterUseTeams: Boolean(settings.suggesterTeamsChannelId),
    suggesterInstructions: settings.suggesterInstructions ?? '',
    announcerFrequency: settings.announcerFrequency,
    announcerSlackChannel:
      settings.announcerSlackChannelName ??
      settings.announcerSlackChannelId ??
      '',
    announcerDiscordChannel: settings.announcerDiscordChannelId ?? '',
    announcerInstructions: settings.announcerInstructions ?? '',
    platformIssueAlertsEnabled: settings.platformIssueAlertsEnabled,
    platformIssueSlackChannel:
      settings.platformIssueSlackChannelName ??
      settings.platformIssueSlackChannelId ??
      '',
    platformIssueDiscordChannel: settings.platformIssueDiscordChannelId ?? '',
    securityAuditorSlackChannel:
      settings.securityAuditorSlackChannelName ??
      settings.securityAuditorSlackChannelId ??
      '',
    securityAuditorDiscordChannel:
      settings.securityAuditorDiscordChannelId ?? '',
    codeQualityAuditorSlackChannel:
      settings.codeQualityAuditorSlackChannelName ??
      settings.codeQualityAuditorSlackChannelId ??
      '',
    codeQualityAuditorDiscordChannel:
      settings.codeQualityAuditorDiscordChannelId ?? '',
    ciFailureTriageSlackChannel:
      settings.ciFailureTriageSlackChannelName ??
      settings.ciFailureTriageSlackChannelId ??
      '',
    ciFailureTriageDiscordChannel:
      settings.ciFailureTriageDiscordChannelId ?? '',
  };
}

export function resolveAutomationHashTarget(hash: string): AutomationId | null {
  const normalized = hash.trim().replace(/^#/, '').toLowerCase();

  if (!normalized) {
    return null;
  }

  return HASH_ALIAS_TO_AUTOMATION_ID[normalized] ?? null;
}

export function buildSlackWorkflowLaunchUrl(
  slackWorkspaceDomain: string | null | undefined,
): string {
  const normalizedDomain = slackWorkspaceDomain
    ?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.slack\.com(?:\/.*)?$/i, '')
    .replace(/\/.*$/, '');

  return normalizedDomain
    ? `https://${normalizedDomain}.slack.com/launch-workflows`
    : 'https://slack.com/launch-workflows';
}

export function isPlatformIssueAlertsEnabled(
  formState: Pick<FormState, 'platformIssueAlertsEnabled'> | null | undefined,
): boolean {
  return formState?.platformIssueAlertsEnabled ?? true;
}

export function canSelectSentryTriageFrequency({
  sentryConnected,
  frequency,
}: {
  sentryConnected: boolean;
  frequency: SentryTriageFrequency;
}): boolean {
  return sentryConnected || frequency === 'off';
}

export function canSaveSentryTriageSettings({
  sentryConnected,
  frequency,
}: {
  sentryConnected: boolean;
  frequency: SentryTriageFrequency;
}): boolean {
  return sentryConnected || frequency === 'off';
}

export function isAutomationRunDisabled({
  isEnabled,
  isDirty,
  isSaving,
  isTriggering,
  isBlocked = false,
}: {
  isEnabled: boolean;
  isDirty: boolean;
  isSaving: boolean;
  isTriggering: boolean;
  isBlocked?: boolean;
}): boolean {
  return isTriggering || !isEnabled || isDirty || isSaving || isBlocked;
}

export function getAutomationRunTooltip({
  isEnabled,
  isDirty,
  isSaving,
  blockedReason,
}: {
  isEnabled: boolean;
  isDirty: boolean;
  isSaving: boolean;
  blockedReason?: string | null;
}): string {
  if (blockedReason) {
    return blockedReason;
  }

  if (!isEnabled) {
    return 'Enable first';
  }

  if (isSaving) {
    return 'Saving...';
  }

  if (isDirty) {
    return 'Save settings first';
  }

  return 'Run now';
}

function hasConfiguredChannelAutoStartRows(
  rows: ChannelAutoStartFormRow[] | null | undefined,
): boolean {
  return (rows ?? []).some((row) =>
    row.provider === 'discord'
      ? Boolean(row.channelId)
      : Boolean(row.slackChannel.trim()),
  );
}

function shouldShowChannelAutoStartWarning(params: {
  formRows: ChannelAutoStartFormRow[] | null | undefined;
  savedChannelIds: string[];
  warningChannelIds: string[];
  isDirty: boolean;
}): boolean {
  if (params.warningChannelIds.length === 0) {
    return false;
  }

  const formChannelValues = new Set(
    (params.formRows ?? [])
      .map((row) => row.slackChannel.trim().toLowerCase())
      .filter(Boolean),
  );
  const warningIds = new Set(
    params.warningChannelIds.map((channelId) => channelId.toLowerCase()),
  );

  for (const channelValue of formChannelValues) {
    if (warningIds.has(channelValue)) {
      return true;
    }
  }

  if (params.isDirty) {
    return false;
  }

  return params.savedChannelIds.some((channelId) =>
    warningIds.has(channelId.toLowerCase()),
  );
}

function LoadingSkeleton() {
  return (
    <div
      className="grid gap-4 md:grid-cols-2"
      data-testid="built-in-automations-skeleton"
    >
      <Skeleton className="col-span-full h-5 w-20" />
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index} className="gap-0 overflow-hidden py-4">
          <CardHeader className="p-0">
            <div className="flex items-start gap-3">
              <Skeleton className="mt-1 size-3 rounded-md" />
              <Skeleton className="mt-1 size-8 rounded-sm" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-full max-w-xl" />
              </div>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function AutomationFooter({
  isDirty,
  isPending,
  saveDisabled = false,
  onSave,
  onReset,
}: {
  isDirty: boolean;
  isPending: boolean;
  saveDisabled?: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!isDirty && !isPending) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onReset}
        disabled={isPending}
      >
        Reset
      </Button>
      <Button size="sm" onClick={onSave} disabled={isPending || saveDisabled}>
        {isPending ? (
          <>
            <Spinner />
            Saving...
            <Check />
          </>
        ) : (
          <>
            Save <Check />
          </>
        )}
      </Button>
    </div>
  );
}

function SlackChannelAccessWarning({
  slackAppMention,
}: {
  slackAppMention: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <TriangleAlert className="size-3.5 shrink-0" />
      Make sure {slackAppMention} is added to that channel.
    </span>
  );
}

const DESTINATION_SOURCE_LABELS: Record<
  ResolvedAutomationDestinationSummary['source'],
  string
> = {
  automation_target: "this automation's channel",
  manager_channel: 'Manager Channel',
  primary_conversation: 'primary conversation (automatic)',
};

function AutomationReportsToLine({
  destination,
  emptyFallbackText,
}: {
  destination: ResolvedAutomationDestinationSummary | null | undefined;
  emptyFallbackText?: string;
}) {
  if (!destination) {
    return (
      <p className="text-xs text-muted-foreground md:max-w-160">
        {emptyFallbackText ??
          'Reports to: not configured — set a Manager Channel.'}
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground md:max-w-160">
      Reports to {destination.displayName ?? destination.channelId} (
      {getCommunicationProviderDisplayName(destination.provider)}) —{' '}
      {DESTINATION_SOURCE_LABELS[destination.source]}
    </p>
  );
}

function AutomationSlackDestinationInput({
  inputId,
  label,
  helperText,
  value,
  options,
  disabled,
  discordConnected = false,
  showWarning,
  slackAppMention,
  error,
  destination,
  reportsToFallbackText,
  onChange,
}: {
  inputId: string;
  label: string;
  helperText?: string;
  value: string | null;
  options: SlackChannelOption[];
  disabled: boolean;
  discordConnected?: boolean;
  showWarning: boolean;
  slackAppMention: string;
  error?: string;
  destination: ResolvedAutomationDestinationSummary | null | undefined;
  reportsToFallbackText?: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <SlackChannelSelect
        id={inputId}
        value={value}
        onChange={onChange}
        options={options}
        disabled={disabled}
        className="w-full md:w-md"
        placeholder={
          disabled && options.length === 0
            ? 'Connect Slack to choose a channel'
            : discordConnected
              ? 'Select a channel'
              : 'Select a Slack channel'
        }
      />
      {helperText ? (
        <p className="text-xs text-muted-foreground md:max-w-160">
          {helperText}
        </p>
      ) : null}
      <AutomationReportsToLine
        destination={destination}
        emptyFallbackText={reportsToFallbackText}
      />
      {showWarning ? (
        <SlackChannelAccessWarning slackAppMention={slackAppMention} />
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function AutomationRunsDebugPanel({
  runs,
  status,
}: {
  runs: AutomationRunSummary[];
  status: AutomationStatusSummary | null;
}) {
  const lastRunAt = asDate(status?.lastRunAt);

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border/70 px-3 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" />
        Recent runs
      </div>
      {status ? (
        <div className="text-xs text-muted-foreground">
          {lastRunAt ? (
            <span title={lastRunAt.toLocaleString()}>
              Last ran{' '}
              {formatDistanceToNowCompact(lastRunAt, { addSuffix: true })}
            </span>
          ) : (
            'Never ran yet.'
          )}
        </div>
      ) : null}
      {status?.lastError ? (
        <p className="max-w-xl text-xs text-destructive">{status.lastError}</p>
      ) : null}
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No launched tasks recorded yet.
        </p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const timestamp = asDate(run.createdAt);

            return (
              <div
                key={run.taskId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-sm border border-border/60 px-3 py-2"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
                        getAutomationRunStatusClasses(run.state),
                      )}
                    >
                      {run.state}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.trigger}
                    </span>
                    {run.title ? (
                      <span className="max-w-96 truncate text-xs text-muted-foreground">
                        {run.title}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {timestamp ? (
                      <span title={timestamp.toLocaleString()}>
                        {formatDistanceToNowCompact(timestamp, {
                          addSuffix: true,
                        })}
                      </span>
                    ) : (
                      'No timestamp'
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {run.sourceUrl && run.sourceLabel ? (
                    <Button asChild variant="ghost" size="sm">
                      <a href={run.sourceUrl} target="_blank" rel="noreferrer">
                        {run.sourceLabel}
                      </a>
                    </Button>
                  ) : null}
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/task/${run.taskId}`}>Open task</Link>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AutomationCard({
  automation,
  isOpen,
  onOpenChange,
  iconEnabled,
  isAvailableMatch = true,
  runAction,
  debugSection,
  footer,
  disabled = false,
  alwaysOpen = false,
  children,
}: {
  automation: AutomationDefinition;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  iconEnabled: boolean;
  isAvailableMatch?: boolean;
  runAction?: React.ReactNode;
  debugSection?: React.ReactNode;
  footer?: React.ReactNode;
  disabled?: boolean;
  alwaysOpen?: boolean;
  children: React.ReactNode;
}) {
  const Icon = automation.icon;
  const open = !disabled && (alwaysOpen || isOpen);
  const actionLabel = iconEnabled
    ? `Configure ${automation.label}`
    : `Set up ${automation.label}`;
  const historyHref = getAutomationHistoryHref(automation.id);

  if (!iconEnabled && !isAvailableMatch) {
    return null;
  }

  return (
    <div
      id={automation.id}
      className={cn('scroll-mt-24', iconEnabled ? 'order-[-20]' : 'order-0')}
      aria-disabled={disabled || undefined}
    >
      <Card
        className={cn(
          'h-full gap-3 px-5 py-4 md:px-6 md:py-6',
          disabled && 'opacity-50',
        )}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex w-[34px] shrink-0 items-start justify-center">
                <div className="rounded-xl border border-border/70 bg-muted/30 p-2">
                  <Icon className="size-5" />
                </div>
              </div>
              <div className="min-w-0 space-y-1">
                <CardTitle className="text-base">{automation.label}</CardTitle>
                {automation.commsBadge || automation.scmBadge ? (
                  <p className="text-sm text-foreground">
                    {[automation.commsBadge, automation.scmBadge]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {automation.description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {historyHref && iconEnabled && !disabled ? (
                <BasicTooltip content="View previous runs">
                  <Button asChild size="icon" variant="ghost">
                    <Link
                      href={historyHref}
                      aria-label={`View previous runs for ${automation.label}`}
                    >
                      <RotateCcwClock />
                    </Link>
                  </Button>
                </BasicTooltip>
              ) : null}
              {runAction && iconEnabled && !disabled ? runAction : null}
              <BasicTooltip content={actionLabel}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={actionLabel}
                  disabled={disabled}
                  onClick={() => onOpenChange(true)}
                >
                  {iconEnabled ? <Settings2 /> : <Plus />}
                </Button>
              </BasicTooltip>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!disabled) {
            onOpenChange(nextOpen);
          }
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{automation.label}</DialogTitle>
            <DialogDescription>{automation.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {children}
            {debugSection}
            {footer ? <div className="flex items-center">{footer}</div> : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScheduledAutomationCard<TFrequency extends string>({
  automation,
  isOpen,
  onOpenChange,
  iconEnabled,
  isAvailableMatch,
  disabled = false,
  debugSection,
  runTooltip,
  runDisabled,
  onRun,
  isDirty,
  isPending,
  saveDisabled = false,
  onSave,
  onReset,
  frequency,
  onFrequencyChange,
  scheduleOptions,
  selectId,
  selectAriaLabel,
  children,
}: {
  automation: AutomationDefinition;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  iconEnabled: boolean;
  isAvailableMatch: boolean;
  disabled?: boolean;
  debugSection?: React.ReactNode;
  runTooltip: string;
  runDisabled: boolean;
  onRun: () => void;
  isDirty: boolean;
  isPending: boolean;
  saveDisabled?: boolean;
  onSave: () => void;
  onReset: () => void;
  frequency: TFrequency;
  onFrequencyChange: (value: TFrequency) => void;
  scheduleOptions: Array<{ value: TFrequency; label: string }>;
  selectId: string;
  selectAriaLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <AutomationCard
      automation={automation}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      iconEnabled={iconEnabled}
      isAvailableMatch={isAvailableMatch}
      disabled={disabled}
      debugSection={debugSection}
      runAction={
        <BasicTooltip content={runTooltip}>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRun}
            disabled={runDisabled}
          >
            <Play />
          </Button>
        </BasicTooltip>
      }
      footer={
        <AutomationFooter
          isDirty={isDirty}
          isPending={isPending}
          saveDisabled={saveDisabled}
          onSave={onSave}
          onReset={onReset}
        />
      }
    >
      <div className="space-y-5">
        <Select
          value={frequency}
          onValueChange={(value) => onFrequencyChange(value as TFrequency)}
        >
          <SelectTrigger
            id={selectId}
            aria-label={selectAriaLabel}
            className="w-full md:w-56"
          >
            <SelectValue placeholder="Select a schedule" />
          </SelectTrigger>
          <SelectContent>
            {scheduleOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {iconEnabled ? children : null}
      </div>
    </AutomationCard>
  );
}

export function AutomationsSettings() {
  const showAutomationDebugRuns = false;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [formState, setFormState] = useState<FormState | null>(null);
  const [savedState, setSavedState] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [slackChannelAccessWarnings, setSlackChannelAccessWarnings] =
    useState<SlackChannelAccessWarnings>(EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS);
  const [managerSlackChannelId, setManagerSlackChannelId] = useState<
    string | null
  >(null);
  const [managerDiscordChannelId, setManagerDiscordChannelId] = useState<
    string | null
  >(null);
  const [savingAutomation, setSavingAutomation] = useState<AutomationId | null>(
    null,
  );
  const [openAutomationIds, setOpenAutomationIds] = useState<Set<AutomationId>>(
    () => new Set(),
  );
  const [availableCategory, setAvailableCategory] = useState<
    AutomationCategory | 'all'
  >('all');
  const [availableSearch, setAvailableSearch] = useState('');
  const formStateRef = useRef<FormState | null>(null);
  const savedStateRef = useRef<FormState | null>(null);
  const didApplyInitialHashRef = useRef(false);

  const connectSlack = useConnectSlack(SETTINGS_PATHS.automations, {
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: () => {
      toast.error('Failed to connect Slack. Please try again.');
    },
  });

  const settingsQuery = useQuery(trpc.automations.getSettings.queryOptions());
  const commsStatus = useQuery(trpc.comms.status.queryOptions());
  const slackChannelsQuery = useQuery(
    trpc.automations.listSlackChannels.queryOptions(undefined, {
      enabled: settingsQuery.data?.capabilities.slackConnected ?? false,
    }),
  );
  const discordChannelsQuery = useQuery(
    trpc.automations.listDiscordChannels.queryOptions(undefined, {
      enabled: settingsQuery.data?.capabilities.discordConnected ?? false,
    }),
  );

  useEffect(() => {
    formStateRef.current = formState;
    savedStateRef.current = savedState;
  }, [formState, savedState]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    const mapped = mapSettingsToFormState({
      ...settingsQuery.data.settings,
      channelAutoStartSlackChannelNames:
        settingsQuery.data.slackChannelDisplayNames
          .channelAutoStartSlackChannels,
      managerSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.managerSlackChannel,
      managerStatsSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.managerStatsSlackChannel,
      providerUsageLimitSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames
          .providerUsageLimitSlackChannel,
      sentryTriageSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.sentryTriageSlackChannel,
      dependabotTriageSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames
          .dependabotTriageSlackChannel,
      codeqlTriageSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.codeqlTriageSlackChannel,
      suggesterSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.suggesterSlackChannel,
      announcerSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.announcerSlackChannel,
      platformIssueSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.platformIssueSlackChannel,
      securityAuditorSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.securityAuditorSlackChannel,
      codeQualityAuditorSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames
          .codeQualityAuditorSlackChannel,
      ciFailureTriageSlackChannelName:
        settingsQuery.data.slackChannelDisplayNames.ciFailureTriageSlackChannel,
      reviewer: settingsQuery.data.reviewer,
    });
    const currentFormState = formStateRef.current;
    const currentSavedState = savedStateRef.current;

    if (!currentFormState || !currentSavedState) {
      setFormState(mapped);
      setSavedState(mapped);
      setSlackChannelAccessWarnings({
        ...EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS,
        ...settingsQuery.data.slackChannelAccessWarnings,
      });
      setManagerSlackChannelId(
        settingsQuery.data.settings.managerSlackChannelId,
      );
      setManagerDiscordChannelId(
        settingsQuery.data.settings.managerDiscordChannelId,
      );
      return;
    }

    const merged = mergeServerStatePreservingDirtySections(
      currentFormState,
      currentSavedState,
      mapped,
    );
    setFormState(merged.formState);
    setSavedState(merged.savedState);
    setSlackChannelAccessWarnings({
      ...EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS,
      ...settingsQuery.data.slackChannelAccessWarnings,
    });
    setManagerSlackChannelId(settingsQuery.data.settings.managerSlackChannelId);
    setManagerDiscordChannelId(
      settingsQuery.data.settings.managerDiscordChannelId,
    );
  }, [settingsQuery.data]);

  const updateMutation = useMutation(
    trpc.automations.updateSettings.mutationOptions({
      onSuccess: (result) => {
        const automationLabel = savingAutomation
          ? AUTOMATION_DEFINITIONS[savingAutomation].label
          : null;
        setSavingAutomation(null);

        if (!result.success) {
          setFieldErrors(result.fieldErrors);
          const firstFieldError = Object.values(result.fieldErrors).find(
            (message): message is string => Boolean(message),
          );

          if (firstFieldError) {
            toast.error(firstFieldError);
          }

          if (
            result.fieldErrors.managerSlackChannel ||
            result.fieldErrors.managerDiscordChannel
          ) {
            setOpenAutomationIds((prev) => {
              if (prev.has('managerChannel')) {
                return prev;
              }

              const next = new Set(prev);
              next.add('managerChannel');
              return next;
            });
          }

          if (
            result.fieldErrors.channelAutoStartSlackChannels ||
            result.fieldErrors.channelAutoStartDiscordChannels ||
            result.fieldErrors.channelAutoStartInstructions
          ) {
            setOpenAutomationIds((prev) => {
              if (prev.has('channelAutoStart')) {
                return prev;
              }

              const next = new Set(prev);
              next.add('channelAutoStart');
              return next;
            });
          }

          if (
            result.fieldErrors.callRoomoteViaEmojiName ||
            result.fieldErrors.callRoomoteViaEmojiInstructions
          ) {
            setOpenAutomationIds((prev) => {
              const next = new Set(prev);
              next.add('callRoomoteViaEmoji');
              return next;
            });
          }
          return;
        }

        setFieldErrors({});
        setSlackChannelAccessWarnings(result.slackChannelAccessWarnings);
        setManagerSlackChannelId(result.settings.managerSlackChannelId);
        setManagerDiscordChannelId(result.settings.managerDiscordChannelId);
        const mapped = mapSettingsToFormState({
          ...result.settings,
          channelAutoStartSlackChannelNames:
            result.slackChannelDisplayNames.channelAutoStartSlackChannels,
          managerSlackChannelName:
            result.slackChannelDisplayNames.managerSlackChannel,
          managerStatsSlackChannelName:
            result.slackChannelDisplayNames.managerStatsSlackChannel,
          providerUsageLimitSlackChannelName:
            result.slackChannelDisplayNames.providerUsageLimitSlackChannel,
          sentryTriageSlackChannelName:
            result.slackChannelDisplayNames.sentryTriageSlackChannel,
          dependabotTriageSlackChannelName:
            result.slackChannelDisplayNames.dependabotTriageSlackChannel,
          codeqlTriageSlackChannelName:
            result.slackChannelDisplayNames.codeqlTriageSlackChannel,
          suggesterSlackChannelName:
            result.slackChannelDisplayNames.suggesterSlackChannel,
          announcerSlackChannelName:
            result.slackChannelDisplayNames.announcerSlackChannel,
          platformIssueSlackChannelName:
            result.slackChannelDisplayNames.platformIssueSlackChannel,
          securityAuditorSlackChannelName:
            result.slackChannelDisplayNames.securityAuditorSlackChannel,
          codeQualityAuditorSlackChannelName:
            result.slackChannelDisplayNames.codeQualityAuditorSlackChannel,
          ciFailureTriageSlackChannelName:
            result.slackChannelDisplayNames.ciFailureTriageSlackChannel,
          reviewer: result.reviewer,
        });
        setFormState((prev) =>
          savingAutomation && prev
            ? mergeAutomationFields(prev, mapped, savingAutomation)
            : mapped,
        );
        setSavedState((prev) =>
          savingAutomation && prev
            ? mergeAutomationFields(prev, mapped, savingAutomation)
            : mapped,
        );

        void queryClient.invalidateQueries({
          queryKey: trpc.automations.getSettings.queryKey(),
        });

        toast.success(
          automationLabel
            ? `Saved settings for the ${automationLabel} automation.`
            : 'Automation settings saved.',
        );
      },
      onError: (error) => {
        const automationLabel = savingAutomation
          ? AUTOMATION_DEFINITIONS[savingAutomation].label
          : null;
        setSavingAutomation(null);
        toast.error(
          automationLabel
            ? `Failed to save ${automationLabel} settings: ${error.message}`
            : error.message,
        );
      },
    }),
  );

  const triggerMutation = useMutation(
    trpc.automations.triggerAutomation.mutationOptions({
      onSuccess: (data, variables) => {
        const automationLabel =
          getTriggerableBackgroundAutomationDescriptorByKey(
            variables.automationKey as TriggerableBackgroundAutomationKey,
          )?.label ?? variables.automationKey;
        void queryClient.invalidateQueries({
          queryKey: trpc.automations.getSettings.queryKey(),
        });

        switch (data.outcome) {
          case 'launched':
            toast.success(`Running ${automationLabel} now`, {
              action: {
                label: 'View task',
                onClick: () => window.open(`/task/${data.taskId}`, '_blank'),
              },
            });
            break;
          case 'completed':
            toast.success(`${automationLabel} ran successfully.`);
            break;
          case 'skipped':
            toast.info(`${automationLabel} had nothing to do: ${data.reason}`);
            break;
          case 'failed':
            toast.error(`${automationLabel} failed: ${data.error}`);
            break;
        }
      },
      onError: (error, variables) => {
        const automationLabel =
          getTriggerableBackgroundAutomationDescriptorByKey(
            variables.automationKey as TriggerableBackgroundAutomationKey,
          )?.label ?? variables.automationKey;
        toast.error(`Failed to run ${automationLabel}: ${error.message}`);
      },
    }),
  );

  const isDirty = useMemo(() => {
    const scheduleOnlyAutomationDirtyState =
      buildScheduleOnlyAutomationDirtyState({
        formState,
        savedState,
      });

    if (!formState || !savedState) {
      return {
        callRoomoteViaEmoji: false,
        channelAutoStart: false,
        managerChannel: false,
        managerStats: false,
        providerUsageLimit: false,
        sentryTriage: false,
        dependabotTriage: false,
        codeqlTriage: false,
        ...scheduleOnlyAutomationDirtyState,
        reviewer: false,
        conflictResolver: false,
        suggester: false,
        announcer: false,
        platformIssueAlerts: false,
      };
    }

    return {
      callRoomoteViaEmoji: isAutomationDirty(
        formState,
        savedState,
        'callRoomoteViaEmoji',
      ),
      channelAutoStart: isAutomationDirty(
        formState,
        savedState,
        'channelAutoStart',
      ),
      managerChannel: isAutomationDirty(
        formState,
        savedState,
        'managerChannel',
      ),
      managerStats: isAutomationDirty(formState, savedState, 'managerStats'),
      providerUsageLimit: isAutomationDirty(
        formState,
        savedState,
        'providerUsageLimit',
      ),
      sentryTriage: isAutomationDirty(formState, savedState, 'sentryTriage'),
      dependabotTriage: isAutomationDirty(
        formState,
        savedState,
        'dependabotTriage',
      ),
      codeqlTriage: isAutomationDirty(formState, savedState, 'codeqlTriage'),
      ...scheduleOnlyAutomationDirtyState,
      reviewer: isAutomationDirty(formState, savedState, 'reviewer'),
      conflictResolver: isAutomationDirty(
        formState,
        savedState,
        'conflictResolver',
      ),
      suggester: isAutomationDirty(formState, savedState, 'suggester'),
      announcer: isAutomationDirty(formState, savedState, 'announcer'),
      platformIssueAlerts: isAutomationDirty(
        formState,
        savedState,
        'platformIssueAlerts',
      ),
    };
  }, [formState, savedState]);

  const recentRunsByAutomation = settingsQuery.data?.recentRuns;

  const automationStatusByKey = settingsQuery.data?.automationStatus;

  const renderDebugRunsSection = useCallback(
    (automationId: AutomationId) => {
      if (!showAutomationDebugRuns) {
        return null;
      }

      const automationKey = AUTOMATION_RUN_KEYS_BY_ID[automationId];

      if (!automationKey) {
        return null;
      }

      return (
        <AutomationRunsDebugPanel
          runs={recentRunsByAutomation?.[automationKey] ?? []}
          status={automationStatusByKey?.[automationKey] ?? null}
        />
      );
    },
    [automationStatusByKey, recentRunsByAutomation, showAutomationDebugRuns],
  );

  const saveAgent = useCallback(
    (automationId: AutomationId) => {
      if (!formState || !savedState) {
        return;
      }

      setFieldErrors({});
      setSavingAutomation(automationId);

      updateMutation.mutate(
        buildAutomationSettingsSaveInput(formState, savedState, automationId),
      );
    },
    [formState, savedState, updateMutation],
  );

  const resetAgent = useCallback(
    (automationId: AutomationId) => {
      if (!formState || !savedState) {
        return;
      }

      setFormState(resetAutomationFields(formState, savedState, automationId));
    },
    [formState, savedState],
  );

  const setAutomationOpen = useCallback(
    (automationId: AutomationId, open: boolean) => {
      setOpenAutomationIds((prev) => {
        const next = new Set(prev);
        if (open) {
          next.add(automationId);
        } else {
          next.delete(automationId);
        }
        return next;
      });

      if (typeof window !== 'undefined') {
        const nextUrl = open
          ? `${window.location.pathname}${window.location.search}#${automationId}`
          : `${window.location.pathname}${window.location.search}`;
        window.history.replaceState(null, '', nextUrl);
      }
    },
    [],
  );

  const setScheduleOnlyAutomationFrequency = useCallback(
    (
      automationId: ScheduleOnlyBackgroundAutomationId,
      frequency: ScheduleOnlyBackgroundAutomationFrequency,
    ) => {
      const automation = SCHEDULE_ONLY_AUTOMATIONS_BY_ID[automationId];

      setFormState((prev) =>
        prev
          ? {
              ...prev,
              [automation.frequencyField]: frequency,
            }
          : prev,
      );
    },
    [],
  );

  const openHashTarget = useCallback((behavior: ScrollBehavior) => {
    if (typeof window === 'undefined') {
      return;
    }

    const target = resolveAutomationHashTarget(window.location.hash);

    if (!target) {
      return;
    }

    setOpenAutomationIds((prev) => {
      if (prev.has(target)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(target);
      return next;
    });

    window.requestAnimationFrame(() => {
      document
        .getElementById(target)
        ?.scrollIntoView({ behavior, block: 'start' });
    });
  }, []);

  useEffect(() => {
    if (
      settingsQuery.isPending ||
      !formState ||
      didApplyInitialHashRef.current
    ) {
      return;
    }

    didApplyInitialHashRef.current = true;
    openHashTarget('auto');
  }, [formState, openHashTarget, settingsQuery.isPending]);

  useEffect(() => {
    const handleHashChange = () => {
      openHashTarget('smooth');
    };

    window.addEventListener('hashchange', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [openHashTarget]);

  const capabilities = settingsQuery.data?.capabilities;
  const slackInvocationIdentity =
    commsStatus.data?.invocationIdentities.find(
      (identity) => identity.provider === 'slack',
    ) ?? null;
  const slackAppMention =
    slackInvocationIdentity?.mentionText ??
    slackInvocationIdentity?.nativeMention ??
    'the Slack app';
  const channelAutoStartLaunchModeOptions =
    CHANNEL_AUTO_START_LAUNCH_MODE_OPTIONS;
  const showChannelAutoStartLaunchModePicker = false;
  const reviewerIsEnabled = formState?.reviewerEnabled ?? false;
  const callRoomoteViaEmojiIsEnabled =
    formState?.callRoomoteViaEmojiEnabled ?? false;
  const conflictResolverIsEnabled =
    formState?.conflictResolverFrequency !== 'off';
  const channelAutoStartIsEnabled = hasConfiguredChannelAutoStartRows(
    formState?.channelAutoStartChannels,
  );
  const availableAutoRespondChannelTemplates = useMemo(
    () =>
      getAvailableAutoRespondChannelTemplates(
        formState?.channelAutoStartChannels,
      ),
    [formState?.channelAutoStartChannels],
  );
  const managerChannelIsEnabled = Boolean(
    formState?.managerSlackChannel.trim() ||
    formState?.managerDiscordChannel.trim(),
  );
  const managerChannelConfigured = Boolean(
    managerSlackChannelId || managerDiscordChannelId,
  );
  const slackChannelChoices = useMemo(
    () => slackChannelsQuery.data?.channels ?? [],
    [slackChannelsQuery.data?.channels],
  );
  const managerStatsIsEnabled = formState?.managerStatsFrequency !== 'off';
  const providerUsageLimitIsEnabled =
    formState?.providerUsageLimitFrequency !== 'off';
  const sentryConnected = capabilities?.sentryConnected === true;
  const sentryTriageIsEnabled = formState?.sentryTriageFrequency !== 'off';
  const dependabotTriageIsEnabled =
    formState?.dependabotTriageFrequency !== 'off';
  const codeqlTriageIsEnabled = formState?.codeqlTriageFrequency !== 'off';
  const scheduleOnlyAutomationEnabledState =
    buildScheduleOnlyAutomationEnabledState(formState);
  const sentryTriageSaveDisabled = !canSaveSentryTriageSettings({
    sentryConnected: sentryConnected,
    frequency: formState?.sentryTriageFrequency ?? 'off',
  });
  const suggesterIsEnabled = formState?.suggesterFrequency !== 'off';
  const announcerIsEnabled = formState?.announcerFrequency !== 'off';
  const showChannelAutoStartSlackChannelWarning =
    shouldShowChannelAutoStartWarning({
      // Access warnings are a Slack concept (the bot must be invited);
      // Discord rows come from the catalog of channels the bot can see.
      formRows: formState?.channelAutoStartChannels.filter(
        (row) => row.provider === 'slack',
      ),
      savedChannelIds:
        settingsQuery.data?.settings.channelAutoStartSlackChannels.map(
          ({ channelId }) => channelId,
        ) ?? [],
      warningChannelIds:
        slackChannelAccessWarnings.channelAutoStartSlackChannels,
      isDirty: isDirty.channelAutoStart,
    });
  const showManagerChannelMigrationNote =
    !formState?.managerSlackChannel &&
    !formState?.managerDiscordChannel &&
    new Set(
      [
        settingsQuery.data?.settings.suggesterSlackChannelId,
        settingsQuery.data?.settings.announcerSlackChannelId,
        settingsQuery.data?.settings.platformIssueSlackChannelId,
      ].filter((value): value is string => Boolean(value)),
    ).size > 1;
  const buildSlackDestinationOptions = useCallback(
    (selectedValue: string | null | undefined) =>
      buildManagerSlackChannelOptions({
        channels: slackChannelChoices,
        selectedValue,
      }),
    [slackChannelChoices],
  );
  const discordConnected = capabilities?.discordConnected === true;
  const slackConnected = capabilities?.slackConnected === true;
  // Unprefixed catalog options for the auto-respond editor's Discord rows
  // (provider is explicit per row, unlike the shared destination combobox).
  // A persisted channel missing from the catalog stays selectable by raw id.
  const channelAutoStartDiscordOptions = useMemo(() => {
    const catalog = (discordChannelsQuery.data?.channels ?? []).map(
      (channel) => ({
        id: channel.id,
        name: channel.name,
        label: channel.label,
      }),
    );
    const knownIds = new Set(catalog.map((option) => option.id));
    const persistedFallbacks = (formState?.channelAutoStartChannels ?? [])
      .filter(
        (row): row is typeof row & { channelId: string } =>
          row.provider === 'discord' &&
          Boolean(row.channelId) &&
          !knownIds.has(row.channelId ?? ''),
      )
      .map((row) => ({
        id: row.channelId,
        name: row.channelId,
        label: row.channelId,
      }));
    return [...catalog, ...persistedFallbacks];
  }, [
    discordChannelsQuery.data?.channels,
    formState?.channelAutoStartChannels,
  ]);
  const renderSlackDestinationField = useCallback(
    ({
      field,
      inputId,
      label,
      helperText,
      savedChannelId,
      savedDiscordChannelId,
      warningChannelId,
      reportsToFallbackText,
      allowTelegram = false,
      savedTelegramSelected = false,
      allowTeams = false,
      savedTeamsSelected = false,
    }: {
      field: AutomationSlackDestinationField;
      inputId: string;
      label: string;
      helperText?: string;
      savedChannelId: string | null;
      savedDiscordChannelId: string | null;
      warningChannelId: string | null;
      reportsToFallbackText?: string;
      /** Suggest Ideas: offer sticky Telegram primary-chat topic. */
      allowTelegram?: boolean;
      savedTelegramSelected?: boolean;
      /** Suggest Ideas: offer primary Teams conversation. */
      allowTeams?: boolean;
      savedTeamsSelected?: boolean;
    }) => {
      const discordField = SLACK_TO_DISCORD_DESTINATION_FIELDS[field];
      const value = formState?.[field] ?? '';
      const discordValue = formState?.[discordField] ?? '';
      const useTelegram =
        allowTelegram && (formState?.suggesterUseTelegram ?? false);
      const useTeams = allowTeams && (formState?.suggesterUseTeams ?? false);
      const telegramConnected =
        settingsQuery.data?.capabilities.telegramConnected ?? false;
      const teamsConnected =
        settingsQuery.data?.capabilities.teamsConnected ?? false;
      const showDiscordOptions = discordConnected || Boolean(discordValue);
      const showTelegramOption =
        allowTelegram &&
        (telegramConnected || useTelegram || savedTelegramSelected);
      const showTeamsOption =
        allowTeams && (teamsConnected || useTeams || savedTeamsSelected);
      const multiProvider =
        showDiscordOptions || showTelegramOption || showTeamsOption;
      const effectiveLabel = multiProvider
        ? label.replace(/ Slack channel$/u, ' channel')
        : label;
      const options = [
        ...buildSlackDestinationOptions(value),
        ...(showDiscordOptions
          ? buildAutomationDiscordDestinationOptions({
              channels: discordChannelsQuery.data?.channels ?? [],
              selectedChannelId: discordValue || null,
              includeProviderSuffix:
                slackConnected || showTelegramOption || showTeamsOption,
            })
          : []),
        ...(showTeamsOption
          ? [
              {
                id: TEAMS_DESTINATION_OPTION,
                name: 'Teams',
                label: 'Teams · primary conversation',
              },
            ]
          : []),
        ...(showTelegramOption
          ? [
              {
                id: TELEGRAM_DESTINATION_OPTION,
                name: 'Telegram',
                label: 'Telegram · recurring topic',
              },
            ]
          : []),
      ];
      const selectedValue = useTelegram
        ? TELEGRAM_DESTINATION_OPTION
        : useTeams
          ? TEAMS_DESTINATION_OPTION
          : discordValue
            ? `${DISCORD_DESTINATION_OPTION_PREFIX}${discordValue}`
            : value || null;

      const destinationHelper = useTelegram
        ? 'Roomote will create a recurring Suggest Ideas topic in your Telegram chat and keep posting there. You can’t pick an existing thread.'
        : useTeams
          ? 'Roomote will post Suggest Ideas digests to your primary Teams conversation.'
          : helperText;

      const clearSuggesterAltDestinations = {
        ...(allowTelegram ? { suggesterUseTelegram: false } : {}),
        ...(allowTeams ? { suggesterUseTeams: false } : {}),
      };

      return (
        <AutomationSlackDestinationInput
          inputId={inputId}
          label={effectiveLabel}
          helperText={destinationHelper}
          value={selectedValue}
          options={options}
          disabled={isManagerChannelSelectionDisabled({
            slackConnected:
              slackConnected ||
              discordConnected ||
              (allowTelegram && telegramConnected) ||
              (allowTeams && teamsConnected),
            isFetching:
              slackChannelsQuery.isFetching || discordChannelsQuery.isFetching,
            hasValue:
              Boolean(value.trim()) ||
              Boolean(discordValue.trim()) ||
              useTelegram ||
              useTeams,
            isConfigured:
              Boolean(savedChannelId) ||
              Boolean(savedDiscordChannelId) ||
              savedTelegramSelected ||
              savedTeamsSelected,
          })}
          discordConnected={
            discordConnected || showTelegramOption || showTeamsOption
          }
          destination={
            settingsQuery.data?.resolvedDestinations[
              SLACK_DESTINATION_FIELD_AUTOMATION_KEYS[field]
            ]
          }
          reportsToFallbackText={reportsToFallbackText}
          slackAppMention={slackAppMention}
          showWarning={
            !discordValue &&
            !useTelegram &&
            !useTeams &&
            shouldShowManagerSlackChannelWarning({
              formValue: value,
              savedChannelId,
              warningChannelId,
              isDirty: isDirty[SLACK_DESTINATION_FIELD_AUTOMATION_IDS[field]],
            })
          }
          error={
            fieldErrors[field] ??
            fieldErrors[discordField] ??
            fieldErrors.suggesterUseTelegram ??
            fieldErrors.suggesterUseTeams
          }
          onChange={(nextValue) =>
            setFormState((prev) => {
              if (!prev) {
                return prev;
              }

              if (nextValue === TELEGRAM_DESTINATION_OPTION) {
                return {
                  ...prev,
                  [field]: '',
                  [discordField]: '',
                  suggesterUseTelegram: true,
                  ...(allowTeams ? { suggesterUseTeams: false } : {}),
                };
              }

              if (nextValue === TEAMS_DESTINATION_OPTION) {
                return {
                  ...prev,
                  [field]: '',
                  [discordField]: '',
                  suggesterUseTeams: true,
                  ...(allowTelegram ? { suggesterUseTelegram: false } : {}),
                };
              }

              if (nextValue?.startsWith(DISCORD_DESTINATION_OPTION_PREFIX)) {
                return {
                  ...prev,
                  [field]: '',
                  [discordField]: nextValue.slice(
                    DISCORD_DESTINATION_OPTION_PREFIX.length,
                  ),
                  ...clearSuggesterAltDestinations,
                };
              }

              return {
                ...prev,
                [field]: nextValue ?? '',
                [discordField]: '',
                ...clearSuggesterAltDestinations,
              };
            })
          }
        />
      );
    },
    [
      buildSlackDestinationOptions,
      slackConnected,
      discordChannelsQuery.data?.channels,
      discordChannelsQuery.isFetching,
      discordConnected,
      fieldErrors,
      formState,
      isDirty,
      settingsQuery.data,
      slackAppMention,
      slackChannelsQuery.isFetching,
    ],
  );

  const iconEnabled = {
    callRoomoteViaEmoji: callRoomoteViaEmojiIsEnabled,
    channelAutoStart: channelAutoStartIsEnabled,
    managerChannel: managerChannelIsEnabled,
    managerStats: managerStatsIsEnabled,
    providerUsageLimit: providerUsageLimitIsEnabled,
    sentryTriage: sentryTriageIsEnabled,
    dependabotTriage: dependabotTriageIsEnabled,
    codeqlTriage: codeqlTriageIsEnabled,
    ...scheduleOnlyAutomationEnabledState,
    reviewer: reviewerIsEnabled,
    conflictResolver: conflictResolverIsEnabled,
    suggester: suggesterIsEnabled,
    announcer: announcerIsEnabled,
    platformIssueAlerts: isPlatformIssueAlertsEnabled(formState),
  } satisfies Record<AutomationId, boolean>;
  const normalizedAvailableSearch = availableSearch.trim().toLowerCase();
  const availableAutomationMatches = new Set(
    Object.values(AUTOMATION_DEFINITIONS)
      .filter(
        (automation) =>
          !iconEnabled[automation.id] &&
          (availableCategory === 'all' ||
            automation.category === availableCategory) &&
          (!normalizedAvailableSearch ||
            [
              automation.label,
              automation.description,
              ...(automation.searchTerms ?? []),
            ]
              .join(' ')
              .toLowerCase()
              .includes(normalizedAvailableSearch)),
      )
      .map((automation) => automation.id),
  );
  const hasAvailableFilters =
    availableCategory !== 'all' || Boolean(normalizedAvailableSearch);

  const isAutomationSaving = (automationId: AutomationId) =>
    updateMutation.isPending && savingAutomation === automationId;

  const isRunDisabled = (
    automationId: AutomationId,
    isEnabled: boolean,
    isBlocked = false,
  ) =>
    isAutomationRunDisabled({
      isEnabled,
      isDirty: isDirty[automationId],
      isSaving: isAutomationSaving(automationId),
      isTriggering: triggerMutation.isPending,
      isBlocked,
    });

  const getRunTooltip = (
    automationId: AutomationId,
    isEnabled: boolean,
    blockedReason?: string | null,
  ) =>
    getAutomationRunTooltip({
      isEnabled,
      isDirty: isDirty[automationId],
      isSaving: isAutomationSaving(automationId),
      blockedReason,
    });
  const slackAutomationsDisabled = !managerChannelConfigured;
  const sentryTriageBlockedReason = !sentryConnected
    ? 'Connect Sentry first'
    : null;
  const dependabotTriageBlockedReason = null;
  const codeqlTriageBlockedReason = null;
  const scheduleOnlyAutomationBlockedReasons = Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
      automation.id,
      null,
    ]),
  ) as Record<ScheduleOnlyBackgroundAutomationId, string | null>;
  return (
    <div className="space-y-6">
      {!settingsQuery.isPending &&
      capabilities?.requiresSlackReconnect &&
      capabilities.missingScopes.length > 0 ? (
        <Alert>
          <AlertDescription className="space-y-3">
            <div className="flex items-center gap-3">
              <AlertCircle className="size-4" />
              <span>
                Your Slack installation is missing some permissions for
                automations to post their findings.
              </span>
              <Button
                size="sm"
                onClick={() => connectSlack.mutate()}
                disabled={connectSlack.isPending}
              >
                <Slack />
                {connectSlack.isPending ? 'Reconnecting...' : 'Reconnect Slack'}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {fieldErrors.general ? (
        <Alert variant="destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <AlertTitle>Unable to save settings</AlertTitle>
          <AlertDescription>{fieldErrors.general}</AlertDescription>
        </Alert>
      ) : null}

      {fieldErrors.managerSlackChannel || fieldErrors.managerDiscordChannel ? (
        <Alert variant="destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <AlertTitle>Manager Channel required</AlertTitle>
          <AlertDescription>
            {fieldErrors.managerSlackChannel ??
              fieldErrors.managerDiscordChannel}
          </AlertDescription>
        </Alert>
      ) : null}

      <CustomAutomationsSection />

      {settingsQuery.isPending || !formState ? (
        <LoadingSkeleton />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <h2 className="order-[-30] col-span-full text-sm font-semibold text-foreground">
              Enabled
            </h2>
            {Object.values(iconEnabled).some(Boolean) ? null : (
              <p className="order-[-20] col-span-full text-sm text-muted-foreground">
                No built-in automations enabled yet.
              </p>
            )}
            <div className="order-[-10] col-span-full flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Available
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={availableCategory}
                  onValueChange={(value) =>
                    setAvailableCategory(value as AutomationCategory | 'all')
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Filter available automations by category"
                    className="w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_CATEGORY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={availableSearch}
                    onChange={(event) =>
                      setAvailableSearch(event.currentTarget.value)
                    }
                    placeholder="Search"
                    aria-label="Search available automations"
                    className="h-8 w-36 pl-8 text-sm"
                  />
                </div>
                {hasAvailableFilters ? (
                  <BasicTooltip content="Clear filters">
                    <Button
                      type="button"
                      size="icon"
                      className="size-8"
                      variant="ghost"
                      aria-label="Clear automation filters"
                      onClick={() => {
                        setAvailableCategory('all');
                        setAvailableSearch('');
                      }}
                    >
                      <X />
                    </Button>
                  </BasicTooltip>
                ) : null}
              </div>
            </div>
            {availableAutomationMatches.size === 0 ? (
              <p className="order-0 col-span-full text-sm text-muted-foreground">
                No available automations match these filters.
              </p>
            ) : null}
            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.callRoomoteViaEmoji}
              isAvailableMatch={availableAutomationMatches.has(
                'callRoomoteViaEmoji',
              )}
              isOpen={openAutomationIds.has('callRoomoteViaEmoji')}
              onOpenChange={(open) =>
                setAutomationOpen('callRoomoteViaEmoji', open)
              }
              iconEnabled={iconEnabled.callRoomoteViaEmoji}
              footer={
                <AutomationFooter
                  isDirty={isDirty.callRoomoteViaEmoji}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'callRoomoteViaEmoji'
                  }
                  onSave={() => saveAgent('callRoomoteViaEmoji')}
                  onReset={() => resetAgent('callRoomoteViaEmoji')}
                />
              }
            >
              <div className="space-y-5">
                <div className="flex items-center gap-2">
                  <Switch
                    id="call-roomote-via-emoji-enabled"
                    checked={formState.callRoomoteViaEmojiEnabled}
                    onCheckedChange={(callRoomoteViaEmojiEnabled) =>
                      setFormState((prev) =>
                        prev ? { ...prev, callRoomoteViaEmojiEnabled } : prev,
                      )
                    }
                  />
                  <Label
                    htmlFor="call-roomote-via-emoji-enabled"
                    className="text-sm"
                  >
                    Allow emoji reactions to call Roomote
                  </Label>
                </div>

                {callRoomoteViaEmojiIsEnabled ? (
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="call-roomote-via-emoji-name">
                        Emoji name
                      </Label>
                      <Input
                        id="call-roomote-via-emoji-name"
                        value={formState.callRoomoteViaEmojiName}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  callRoomoteViaEmojiName: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder=":white_check_mark:"
                      />
                      <p className="text-xs text-muted-foreground">
                        Enter the reaction name, with or without surrounding
                        colons. Microsoft Teams supports its native Like, Heart,
                        Laugh, Surprised, Sad, and Angry reactions on messages
                        posted by Roomote.
                      </p>
                      {fieldErrors.callRoomoteViaEmojiName ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.callRoomoteViaEmojiName}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="call-roomote-via-emoji-instructions">
                        Additional instructions
                      </Label>
                      <Textarea
                        id="call-roomote-via-emoji-instructions"
                        value={formState.callRoomoteViaEmojiInstructions}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  callRoomoteViaEmojiInstructions:
                                    event.target.value,
                                }
                              : prev,
                          )
                        }
                        rows={4}
                        placeholder={
                          'Optional guidance to add after "Act on this"'
                        }
                      />
                      {fieldErrors.callRoomoteViaEmojiInstructions ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.callRoomoteViaEmojiInstructions}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.reviewer}
              isAvailableMatch={availableAutomationMatches.has('reviewer')}
              isOpen={openAutomationIds.has('reviewer')}
              onOpenChange={(open) => setAutomationOpen('reviewer', open)}
              iconEnabled={iconEnabled.reviewer}
              footer={
                <AutomationFooter
                  isDirty={isDirty.reviewer}
                  isPending={
                    updateMutation.isPending && savingAutomation === 'reviewer'
                  }
                  onSave={() => saveAgent('reviewer')}
                  onReset={() => resetAgent('reviewer')}
                />
              }
            >
              <div className="space-y-5">
                <div className="flex items-center gap-2">
                  <Switch
                    id="reviewer-enabled"
                    checked={formState.reviewerEnabled}
                    onCheckedChange={(reviewerEnabled) =>
                      setFormState((prev) =>
                        prev ? { ...prev, reviewerEnabled } : prev,
                      )
                    }
                  />
                  <Label htmlFor="reviewer-enabled" className="text-sm">
                    Allow {PRODUCT_NAME} to review PRs
                  </Label>
                </div>

                {reviewerIsEnabled ? (
                  <div className="space-y-6 pt-1">
                    <div className="flex items-start gap-2">
                      <Switch
                        className="mt-1"
                        checked={formState.reviewerReviewOnCommit}
                        onCheckedChange={(reviewerReviewOnCommit) =>
                          setFormState((prev) =>
                            prev ? { ...prev, reviewerReviewOnCommit } : prev,
                          )
                        }
                      />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Automatically review new PRs and follow-up commits.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Disable to only get reviews by asking @-mentioning{' '}
                          {PRODUCT_NAME}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2">
                      <Switch
                        className="mt-1"
                        checked={formState.reviewerReviewDraftPrs}
                        onCheckedChange={(reviewerReviewDraftPrs) =>
                          setFormState((prev) =>
                            prev ? { ...prev, reviewerReviewDraftPrs } : prev,
                          )
                        }
                      />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Review draft PRs</p>
                        <p className="text-xs text-muted-foreground">
                          Turn off to only automatically review PRs marked as
                          ready (and save tokens)
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2">
                      <Switch
                        className="mt-1"
                        aria-label={`Review PRs not created by ${PRODUCT_NAME}`}
                        checked={formState.reviewerReviewAllPullRequestAuthors}
                        onCheckedChange={(
                          reviewerReviewAllPullRequestAuthors,
                        ) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  reviewerReviewAllPullRequestAuthors,
                                }
                              : prev,
                          )
                        }
                      />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Review PRs not created by {PRODUCT_NAME}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Include pull requests opened by people or others
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2">
                      <Switch
                        className="mt-1"
                        aria-label="Publish review results as a GitHub check"
                        checked={formState.reviewerPublishGithubCheck}
                        onCheckedChange={(reviewerPublishGithubCheck) =>
                          setFormState((prev) =>
                            prev
                              ? { ...prev, reviewerPublishGithubCheck }
                              : prev,
                          )
                        }
                      />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Publish review results as a GitHub check
                        </p>
                        <p className="text-xs text-muted-foreground">
                          GitHub branch protection or rulesets control whether
                          this check is required for merging.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="reviewer-instructions">
                        Additional instructions
                      </Label>
                      <Textarea
                        id="reviewer-instructions"
                        value={formState.reviewerInstructions}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  reviewerInstructions: event.target.value,
                                }
                              : prev,
                          )
                        }
                        rows={4}
                        placeholder="Optional guidance for how to review code and report findings"
                      />
                      {fieldErrors.reviewerInstructions ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.reviewerInstructions}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            {(
              [
                'issueFixer',
              ] as const satisfies readonly ScheduleOnlyBackgroundAutomationId[]
            ).map((automationId) => {
              const automation = SCHEDULE_ONLY_AUTOMATIONS_BY_ID[automationId];
              const automationUi =
                SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS[automation.id];
              const frequency = formState[automation.frequencyField];
              const isEnabled =
                scheduleOnlyAutomationEnabledState[automation.id];
              const fieldId = `${automation.automationKey.replaceAll('_', '-')}-frequency`;

              return (
                <AutomationCard
                  key={automation.id}
                  automation={AUTOMATION_DEFINITIONS[automation.id]}
                  isAvailableMatch={availableAutomationMatches.has(
                    automation.id,
                  )}
                  isOpen={openAutomationIds.has(automation.id)}
                  onOpenChange={(open) =>
                    setAutomationOpen(automation.id, open)
                  }
                  iconEnabled={iconEnabled[automation.id]}
                  debugSection={renderDebugRunsSection(automation.id)}
                  footer={
                    <AutomationFooter
                      isDirty={isDirty[automation.id]}
                      isPending={
                        updateMutation.isPending &&
                        savingAutomation === automation.id
                      }
                      onSave={() => saveAgent(automation.id)}
                      onReset={() => resetAgent(automation.id)}
                    />
                  }
                >
                  <ScheduleOnlyAutomationContent
                    automationLabel={automation.label}
                    control={
                      automationUi.control.kind === 'schedule'
                        ? {
                            ...automationUi.control,
                            scheduleOptions:
                              SCHEDULE_ONLY_AUTOMATION_FREQUENCY_OPTIONS,
                          }
                        : automationUi.control
                    }
                    details={automationUi.details}
                    frequency={frequency}
                    isEnabled={isEnabled}
                    disabled={false}
                    fieldId={fieldId}
                    onFrequencyChange={(nextFrequency) =>
                      setScheduleOnlyAutomationFrequency(
                        automation.id,
                        nextFrequency,
                      )
                    }
                  >
                    {automation.id === 'issueFixer' ? (
                      <div className="space-y-2">
                        <Label htmlFor="issue-fixer-instructions">
                          Additional instructions
                        </Label>
                        <Textarea
                          id="issue-fixer-instructions"
                          value={formState.issueFixerInstructions}
                          onChange={(event) =>
                            setFormState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    issueFixerInstructions: event.target.value,
                                  }
                                : prev,
                            )
                          }
                          rows={4}
                          placeholder="Optional guidance for how to triage issues and write plans"
                        />
                        {fieldErrors.issueFixerInstructions ? (
                          <p className="text-xs text-destructive">
                            {fieldErrors.issueFixerInstructions}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </ScheduleOnlyAutomationContent>
                </AutomationCard>
              );
            })}

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.conflictResolver}
              isAvailableMatch={availableAutomationMatches.has(
                'conflictResolver',
              )}
              isOpen={openAutomationIds.has('conflictResolver')}
              onOpenChange={(open) =>
                setAutomationOpen('conflictResolver', open)
              }
              iconEnabled={iconEnabled.conflictResolver}
              debugSection={renderDebugRunsSection('conflictResolver')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip(
                    'conflictResolver',
                    conflictResolverIsEnabled,
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({
                        automationKey: 'conflict_resolver',
                      })
                    }
                    disabled={isRunDisabled(
                      'conflictResolver',
                      conflictResolverIsEnabled,
                    )}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.conflictResolver}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'conflictResolver'
                  }
                  onSave={() => saveAgent('conflictResolver')}
                  onReset={() => resetAgent('conflictResolver')}
                />
              }
            >
              <div className="space-y-5">
                <Select
                  value={formState.conflictResolverFrequency}
                  onValueChange={(value) =>
                    setFormState((prev) =>
                      prev
                        ? {
                            ...prev,
                            conflictResolverFrequency:
                              value as ConflictResolverFrequency,
                          }
                        : prev,
                    )
                  }
                >
                  <SelectTrigger
                    id="conflict-resolver-frequency"
                    aria-label="Resolve PR Conflicts schedule"
                    className="w-full md:w-56"
                  >
                    <SelectValue placeholder="Select a schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFLICT_RESOLVER_FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {conflictResolverIsEnabled ? (
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="conflict-resolver-max-pr-age">
                        PR age cap
                      </Label>
                      <Select
                        value={String(formState.conflictResolverMaxPrAgeDays)}
                        onValueChange={(value) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  conflictResolverMaxPrAgeDays: Number(
                                    value,
                                  ) as ConflictResolverMaxPrAgeDays,
                                }
                              : prev,
                          )
                        }
                      >
                        <SelectTrigger
                          id="conflict-resolver-max-pr-age"
                          aria-label="Resolve PR Conflicts PR age cap"
                          className="w-full md:w-56"
                        >
                          <SelectValue placeholder="Select a cap" />
                        </SelectTrigger>
                        <SelectContent>
                          {CONFLICT_RESOLVER_MAX_PR_AGE_OPTIONS.map(
                            (option) => (
                              <SelectItem
                                key={option.value}
                                value={String(option.value)}
                              >
                                {option.label}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground md:max-w-120">
                        Sets the maximum PR age that Resolve PR Conflicts will
                        consider. Labeled PRs older than this are skipped.
                      </p>
                      {fieldErrors.conflictResolverMaxPrAgeDays ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.conflictResolverMaxPrAgeDays}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="conflict-label">Auto-resolve label</Label>
                      <Input
                        id="conflict-label"
                        value={formState.conflictResolverLabel}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  conflictResolverLabel: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder="roomote:auto-resolve-conflicts"
                        className="max-w-80"
                      />
                      <p className="text-xs text-muted-foreground md:max-w-120">
                        Make sure this label exists in your repos. It will be
                        added automatically to all new agent PRs. Remove it
                        whenever you do not want conflicts resolved.
                      </p>
                      {fieldErrors.conflictResolverLabel ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.conflictResolverLabel}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="conflict-resolver-instructions">
                        Additional instructions
                      </Label>
                      <Textarea
                        id="conflict-resolver-instructions"
                        value={formState.conflictResolverInstructions}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  conflictResolverInstructions:
                                    event.target.value,
                                }
                              : prev,
                          )
                        }
                        rows={4}
                        placeholder="Optional guidance for conflict resolution strategy and priorities"
                      />
                      {fieldErrors.conflictResolverInstructions ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.conflictResolverInstructions}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            {(
              [
                'ciFailureTriage',
              ] as const satisfies readonly ScheduleOnlyBackgroundAutomationId[]
            ).map((automationId) => {
              const automation = SCHEDULE_ONLY_AUTOMATIONS_BY_ID[automationId];
              const automationUi =
                SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS[automation.id];
              const frequency = formState[automation.frequencyField];
              const isEnabled =
                scheduleOnlyAutomationEnabledState[automation.id];
              const blockedReason =
                scheduleOnlyAutomationBlockedReasons[automation.id];
              const fieldId = `${automation.automationKey.replaceAll('_', '-')}-frequency`;

              return (
                <AutomationCard
                  key={automation.id}
                  automation={AUTOMATION_DEFINITIONS[automation.id]}
                  isAvailableMatch={availableAutomationMatches.has(
                    automation.id,
                  )}
                  isOpen={openAutomationIds.has(automation.id)}
                  onOpenChange={(open) =>
                    setAutomationOpen(automation.id, open)
                  }
                  iconEnabled={iconEnabled[automation.id]}
                  debugSection={renderDebugRunsSection(automation.id)}
                  runAction={
                    <BasicTooltip
                      content={getRunTooltip(
                        automation.id,
                        isEnabled,
                        blockedReason,
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          triggerMutation.mutate({
                            automationKey: automation.automationKey,
                          })
                        }
                        disabled={isRunDisabled(
                          automation.id,
                          isEnabled,
                          blockedReason != null,
                        )}
                      >
                        <Play />
                      </Button>
                    </BasicTooltip>
                  }
                  footer={
                    <AutomationFooter
                      isDirty={isDirty[automation.id]}
                      isPending={
                        updateMutation.isPending &&
                        savingAutomation === automation.id
                      }
                      onSave={() => saveAgent(automation.id)}
                      onReset={() => resetAgent(automation.id)}
                    />
                  }
                >
                  <ScheduleOnlyAutomationContent
                    automationLabel={automation.label}
                    control={
                      automationUi.control.kind === 'schedule'
                        ? {
                            ...automationUi.control,
                            scheduleOptions:
                              SCHEDULE_ONLY_AUTOMATION_FREQUENCY_OPTIONS,
                          }
                        : automationUi.control
                    }
                    details={automationUi.details}
                    frequency={frequency}
                    isEnabled={isEnabled}
                    disabled={false}
                    fieldId={fieldId}
                    onFrequencyChange={(nextFrequency) =>
                      setScheduleOnlyAutomationFrequency(
                        automation.id,
                        nextFrequency,
                      )
                    }
                  >
                    {renderSlackDestinationField({
                      field:
                        automation.id === 'securityAuditor'
                          ? 'securityAuditorSlackChannel'
                          : automation.id === 'codeQualityAuditor'
                            ? 'codeQualityAuditorSlackChannel'
                            : 'ciFailureTriageSlackChannel',
                      inputId: `${automation.id}-slack-channel`,
                      label: 'Post follow-up work to this Slack channel',
                      helperText:
                        automation.id === 'ciFailureTriage'
                          ? 'Choose where Roomote should post CI failure triage work.'
                          : 'Choose where Roomote should post actionable follow-up work.',
                      savedChannelId:
                        automation.id === 'securityAuditor'
                          ? (settingsQuery.data?.settings
                              .securityAuditorSlackChannelId ?? null)
                          : automation.id === 'codeQualityAuditor'
                            ? (settingsQuery.data?.settings
                                .codeQualityAuditorSlackChannelId ?? null)
                            : (settingsQuery.data?.settings
                                .ciFailureTriageSlackChannelId ?? null),
                      savedDiscordChannelId:
                        automation.id === 'securityAuditor'
                          ? (settingsQuery.data?.settings
                              .securityAuditorDiscordChannelId ?? null)
                          : automation.id === 'codeQualityAuditor'
                            ? (settingsQuery.data?.settings
                                .codeQualityAuditorDiscordChannelId ?? null)
                            : (settingsQuery.data?.settings
                                .ciFailureTriageDiscordChannelId ?? null),
                      warningChannelId:
                        automation.id === 'securityAuditor'
                          ? slackChannelAccessWarnings.securityAuditorSlackChannel
                          : automation.id === 'codeQualityAuditor'
                            ? slackChannelAccessWarnings.codeQualityAuditorSlackChannel
                            : slackChannelAccessWarnings.ciFailureTriageSlackChannel,
                    })}
                  </ScheduleOnlyAutomationContent>
                </AutomationCard>
              );
            })}

            <ScheduledAutomationCard
              automation={AUTOMATION_DEFINITIONS.dependabotTriage}
              isAvailableMatch={availableAutomationMatches.has(
                'dependabotTriage',
              )}
              isOpen={openAutomationIds.has('dependabotTriage')}
              onOpenChange={(open) =>
                setAutomationOpen('dependabotTriage', open)
              }
              iconEnabled={iconEnabled.dependabotTriage}
              debugSection={renderDebugRunsSection('dependabotTriage')}
              runTooltip={getRunTooltip(
                'dependabotTriage',
                dependabotTriageIsEnabled,
                dependabotTriageBlockedReason,
              )}
              runDisabled={isRunDisabled(
                'dependabotTriage',
                dependabotTriageIsEnabled,
                dependabotTriageBlockedReason != null,
              )}
              onRun={() =>
                triggerMutation.mutate({ automationKey: 'dependabot_triage' })
              }
              isDirty={isDirty.dependabotTriage}
              isPending={
                updateMutation.isPending &&
                savingAutomation === 'dependabotTriage'
              }
              onSave={() => saveAgent('dependabotTriage')}
              onReset={() => resetAgent('dependabotTriage')}
              frequency={formState.dependabotTriageFrequency}
              onFrequencyChange={(frequency) =>
                setFormState((prev) =>
                  prev
                    ? {
                        ...prev,
                        dependabotTriageFrequency: frequency,
                      }
                    : prev,
                )
              }
              scheduleOptions={
                SENTRY_TRIAGE_FREQUENCY_OPTIONS as Array<{
                  value: DependabotTriageFrequency;
                  label: string;
                }>
              }
              selectId="dependabot-triage-frequency"
              selectAriaLabel="Triage Dependabot Alerts schedule"
            >
              <div className="space-y-5">
                {dependabotTriageIsEnabled
                  ? renderSlackDestinationField({
                      field: 'dependabotTriageSlackChannel',
                      inputId: 'dependabot-triage-slack-channel',
                      label: 'Post follow-up work to this Slack channel',
                      helperText:
                        'Choose where Roomote should post actionable Dependabot follow-up work.',
                      savedChannelId:
                        settingsQuery.data?.settings
                          .dependabotTriageSlackChannelId ?? null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .dependabotTriageDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.dependabotTriageSlackChannel,
                    })
                  : null}

                <p className="text-xs text-muted-foreground md:max-w-160">
                  Scans current open Dependabot alerts across active
                  repositories and suggests tightly scoped dependency update
                  tasks instead of opening PRs directly.
                </p>
              </div>
            </ScheduledAutomationCard>

            <ScheduledAutomationCard
              automation={AUTOMATION_DEFINITIONS.codeqlTriage}
              isAvailableMatch={availableAutomationMatches.has('codeqlTriage')}
              isOpen={openAutomationIds.has('codeqlTriage')}
              onOpenChange={(open) => setAutomationOpen('codeqlTriage', open)}
              iconEnabled={iconEnabled.codeqlTriage}
              debugSection={renderDebugRunsSection('codeqlTriage')}
              runTooltip={getRunTooltip(
                'codeqlTriage',
                codeqlTriageIsEnabled,
                codeqlTriageBlockedReason,
              )}
              runDisabled={isRunDisabled(
                'codeqlTriage',
                codeqlTriageIsEnabled,
                codeqlTriageBlockedReason != null,
              )}
              onRun={() =>
                triggerMutation.mutate({ automationKey: 'codeql_triage' })
              }
              isDirty={isDirty.codeqlTriage}
              isPending={
                updateMutation.isPending && savingAutomation === 'codeqlTriage'
              }
              onSave={() => saveAgent('codeqlTriage')}
              onReset={() => resetAgent('codeqlTriage')}
              frequency={formState.codeqlTriageFrequency}
              onFrequencyChange={(frequency) =>
                setFormState((prev) =>
                  prev
                    ? {
                        ...prev,
                        codeqlTriageFrequency: frequency,
                      }
                    : prev,
                )
              }
              scheduleOptions={
                SENTRY_TRIAGE_FREQUENCY_OPTIONS as Array<{
                  value: CodeqlTriageFrequency;
                  label: string;
                }>
              }
              selectId="codeql-triage-frequency"
              selectAriaLabel="Triage CodeQL Alerts schedule"
            >
              <div className="space-y-5">
                {codeqlTriageIsEnabled
                  ? renderSlackDestinationField({
                      field: 'codeqlTriageSlackChannel',
                      inputId: 'codeql-triage-slack-channel',
                      label: 'Post follow-up work to this Slack channel',
                      helperText:
                        'Choose where Roomote should post actionable CodeQL follow-up work.',
                      savedChannelId:
                        settingsQuery.data?.settings
                          .codeqlTriageSlackChannelId ?? null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .codeqlTriageDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.codeqlTriageSlackChannel,
                    })
                  : null}

                <p className="text-xs text-muted-foreground md:max-w-160">
                  Scans current open code-scanning/CodeQL alerts across active
                  repositories and launches implement-changes follow-up tasks
                  instead of opening PRs in the scan itself.
                </p>
              </div>
            </ScheduledAutomationCard>

            {(
              [
                'codeQualityAuditor',
                'securityAuditor',
              ] as const satisfies readonly ScheduleOnlyBackgroundAutomationId[]
            ).map((automationId) => {
              const automation = SCHEDULE_ONLY_AUTOMATIONS_BY_ID[automationId];
              const automationUi =
                SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS[automation.id];
              const frequency = formState[automation.frequencyField];
              const isEnabled =
                scheduleOnlyAutomationEnabledState[automation.id];
              const blockedReason =
                scheduleOnlyAutomationBlockedReasons[automation.id];
              const fieldId = `${automation.automationKey.replaceAll('_', '-')}-frequency`;

              return (
                <AutomationCard
                  key={automation.id}
                  automation={AUTOMATION_DEFINITIONS[automation.id]}
                  isAvailableMatch={availableAutomationMatches.has(
                    automation.id,
                  )}
                  isOpen={openAutomationIds.has(automation.id)}
                  onOpenChange={(open) =>
                    setAutomationOpen(automation.id, open)
                  }
                  iconEnabled={iconEnabled[automation.id]}
                  debugSection={renderDebugRunsSection(automation.id)}
                  runAction={
                    <BasicTooltip
                      content={getRunTooltip(
                        automation.id,
                        isEnabled,
                        blockedReason,
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          triggerMutation.mutate({
                            automationKey: automation.automationKey,
                          })
                        }
                        disabled={isRunDisabled(
                          automation.id,
                          isEnabled,
                          blockedReason != null,
                        )}
                      >
                        <Play />
                      </Button>
                    </BasicTooltip>
                  }
                  footer={
                    <AutomationFooter
                      isDirty={isDirty[automation.id]}
                      isPending={
                        updateMutation.isPending &&
                        savingAutomation === automation.id
                      }
                      onSave={() => saveAgent(automation.id)}
                      onReset={() => resetAgent(automation.id)}
                    />
                  }
                >
                  <ScheduleOnlyAutomationContent
                    automationLabel={automation.label}
                    control={
                      automationUi.control.kind === 'schedule'
                        ? {
                            ...automationUi.control,
                            scheduleOptions:
                              SCHEDULE_ONLY_AUTOMATION_FREQUENCY_OPTIONS,
                          }
                        : automationUi.control
                    }
                    details={automationUi.details}
                    frequency={frequency}
                    isEnabled={isEnabled}
                    disabled={false}
                    fieldId={fieldId}
                    onFrequencyChange={(nextFrequency) =>
                      setScheduleOnlyAutomationFrequency(
                        automation.id,
                        nextFrequency,
                      )
                    }
                  >
                    {renderSlackDestinationField({
                      field:
                        automation.id === 'securityAuditor'
                          ? 'securityAuditorSlackChannel'
                          : automation.id === 'codeQualityAuditor'
                            ? 'codeQualityAuditorSlackChannel'
                            : 'ciFailureTriageSlackChannel',
                      inputId: `${automation.id}-slack-channel`,
                      label: 'Post follow-up work to this Slack channel',
                      helperText:
                        automation.id === 'ciFailureTriage'
                          ? 'Choose where Roomote should post CI failure triage work.'
                          : 'Choose where Roomote should post actionable follow-up work.',
                      savedChannelId:
                        automation.id === 'securityAuditor'
                          ? (settingsQuery.data?.settings
                              .securityAuditorSlackChannelId ?? null)
                          : automation.id === 'codeQualityAuditor'
                            ? (settingsQuery.data?.settings
                                .codeQualityAuditorSlackChannelId ?? null)
                            : (settingsQuery.data?.settings
                                .ciFailureTriageSlackChannelId ?? null),
                      savedDiscordChannelId:
                        automation.id === 'securityAuditor'
                          ? (settingsQuery.data?.settings
                              .securityAuditorDiscordChannelId ?? null)
                          : automation.id === 'codeQualityAuditor'
                            ? (settingsQuery.data?.settings
                                .codeQualityAuditorDiscordChannelId ?? null)
                            : (settingsQuery.data?.settings
                                .ciFailureTriageDiscordChannelId ?? null),
                      warningChannelId:
                        automation.id === 'securityAuditor'
                          ? slackChannelAccessWarnings.securityAuditorSlackChannel
                          : automation.id === 'codeQualityAuditor'
                            ? slackChannelAccessWarnings.codeQualityAuditorSlackChannel
                            : slackChannelAccessWarnings.ciFailureTriageSlackChannel,
                    })}
                  </ScheduleOnlyAutomationContent>
                </AutomationCard>
              );
            })}

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.channelAutoStart}
              isAvailableMatch={availableAutomationMatches.has(
                'channelAutoStart',
              )}
              isOpen={openAutomationIds.has('channelAutoStart')}
              onOpenChange={(open) =>
                setAutomationOpen('channelAutoStart', open)
              }
              iconEnabled={iconEnabled.channelAutoStart}
              footer={
                <AutomationFooter
                  isDirty={isDirty.channelAutoStart}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'channelAutoStart'
                  }
                  onSave={() => saveAgent('channelAutoStart')}
                  onReset={() => resetAgent('channelAutoStart')}
                />
              }
            >
              <ChannelAutoStartEditor
                slackAppMention={slackAppMention}
                rows={formState.channelAutoStartChannels}
                launchModeOptions={channelAutoStartLaunchModeOptions}
                showLaunchModePicker={showChannelAutoStartLaunchModePicker}
                availableTemplates={availableAutoRespondChannelTemplates}
                isEnabled={channelAutoStartIsEnabled}
                discordConnected={discordConnected}
                discordChannelOptions={channelAutoStartDiscordOptions}
                warning={
                  showChannelAutoStartSlackChannelWarning ? (
                    <SlackChannelAccessWarning
                      slackAppMention={slackAppMention}
                    />
                  ) : undefined
                }
                channelFieldError={fieldErrors.channelAutoStartSlackChannels}
                discordChannelFieldError={
                  fieldErrors.channelAutoStartDiscordChannels
                }
                instructionsFieldError={
                  fieldErrors.channelAutoStartInstructions
                }
                onRowsChange={(rows) =>
                  setFormState((prev) =>
                    prev
                      ? {
                          ...prev,
                          channelAutoStartChannels: rows,
                        }
                      : prev,
                  )
                }
              />
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.managerChannel}
              isAvailableMatch={availableAutomationMatches.has(
                'managerChannel',
              )}
              isOpen={openAutomationIds.has('managerChannel')}
              onOpenChange={(open) => setAutomationOpen('managerChannel', open)}
              iconEnabled={iconEnabled.managerChannel}
            >
              <ManagerChannelEditor
                value={{
                  slackChannel: formState.managerSlackChannel,
                  discordChannel: formState.managerDiscordChannel,
                }}
                savedSlackChannel={savedState?.managerSlackChannel ?? ''}
                savedSlackChannelId={managerSlackChannelId}
                savedDiscordChannelId={managerDiscordChannelId}
                slackChannels={slackChannelsQuery.data?.channels ?? []}
                discordChannels={discordChannelsQuery.data?.channels ?? []}
                slackConnected={capabilities?.slackConnected === true}
                discordConnected={capabilities?.discordConnected === true}
                channelsPending={
                  slackChannelsQuery.isPending || discordChannelsQuery.isPending
                }
                channelsFetching={
                  slackChannelsQuery.isFetching ||
                  discordChannelsQuery.isFetching
                }
                channelsError={
                  slackChannelsQuery.isError || discordChannelsQuery.isError
                }
                isDirty={isDirty.managerChannel}
                isSaving={
                  updateMutation.isPending &&
                  savingAutomation === 'managerChannel'
                }
                warningChannelId={
                  slackChannelAccessWarnings.managerSlackChannel
                }
                slackAppMention={slackAppMention}
                fieldError={
                  fieldErrors.managerSlackChannel ??
                  fieldErrors.managerDiscordChannel
                }
                showMigrationNote={showManagerChannelMigrationNote}
                onChange={({ slackChannel, discordChannel }) =>
                  setFormState((prev) =>
                    prev
                      ? {
                          ...prev,
                          managerSlackChannel: slackChannel,
                          managerDiscordChannel: discordChannel,
                        }
                      : prev,
                  )
                }
                onRefresh={() => {
                  void Promise.all([
                    slackChannelsQuery.refetch(),
                    discordChannelsQuery.refetch(),
                  ]);
                }}
                onSave={() => saveAgent('managerChannel')}
                onReset={() => resetAgent('managerChannel')}
              />
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.managerStats}
              isAvailableMatch={availableAutomationMatches.has('managerStats')}
              isOpen={openAutomationIds.has('managerStats')}
              onOpenChange={(open) => setAutomationOpen('managerStats', open)}
              iconEnabled={iconEnabled.managerStats}
              debugSection={renderDebugRunsSection('managerStats')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip('managerStats', managerStatsIsEnabled)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({
                        automationKey: 'manager_stats',
                      })
                    }
                    disabled={isRunDisabled(
                      'managerStats',
                      managerStatsIsEnabled,
                    )}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.managerStats}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'managerStats'
                  }
                  onSave={() => saveAgent('managerStats')}
                  onReset={() => resetAgent('managerStats')}
                />
              }
            >
              <div className="space-y-5">
                <div className="flex items-center gap-2">
                  <Switch
                    id="manager-stats-enabled"
                    checked={managerStatsIsEnabled}
                    onCheckedChange={(enabled) =>
                      setFormState((prev) =>
                        prev
                          ? {
                              ...prev,
                              managerStatsFrequency: enabled ? 'weekly' : 'off',
                            }
                          : prev,
                      )
                    }
                  />
                  <Label htmlFor="manager-stats-enabled" className="text-sm">
                    Enabled
                  </Label>
                </div>

                {managerStatsIsEnabled ? (
                  <div className="space-y-5">
                    {renderSlackDestinationField({
                      field: 'managerStatsSlackChannel',
                      inputId: 'manager-stats-slack-channel',
                      label: 'Post summaries to this Slack channel',
                      helperText:
                        'Choose where Roomote should post the Friday manager digest.',
                      savedChannelId:
                        settingsQuery.data?.settings
                          .managerStatsSlackChannelId ?? null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .managerStatsDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.managerStatsSlackChannel,
                    })}

                    <p className="text-xs text-muted-foreground md:max-w-160">
                      Posts a weekly summary on Fridays.
                    </p>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.providerUsageLimit}
              isAvailableMatch={availableAutomationMatches.has(
                'providerUsageLimit',
              )}
              isOpen={openAutomationIds.has('providerUsageLimit')}
              onOpenChange={(open) =>
                setAutomationOpen('providerUsageLimit', open)
              }
              iconEnabled={iconEnabled.providerUsageLimit}
              debugSection={renderDebugRunsSection('providerUsageLimit')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip(
                    'providerUsageLimit',
                    providerUsageLimitIsEnabled,
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({
                        automationKey: 'provider_usage_limit',
                      })
                    }
                    disabled={isRunDisabled(
                      'providerUsageLimit',
                      providerUsageLimitIsEnabled,
                    )}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.providerUsageLimit}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'providerUsageLimit'
                  }
                  onSave={() => saveAgent('providerUsageLimit')}
                  onReset={() => resetAgent('providerUsageLimit')}
                />
              }
            >
              <div className="space-y-5">
                <div className="flex items-center gap-2">
                  <Switch
                    id="provider-usage-limit-enabled"
                    checked={providerUsageLimitIsEnabled}
                    onCheckedChange={(enabled) =>
                      setFormState((prev) =>
                        prev
                          ? {
                              ...prev,
                              providerUsageLimitFrequency: enabled
                                ? 'every_hour'
                                : 'off',
                            }
                          : prev,
                      )
                    }
                  />
                  <Label
                    htmlFor="provider-usage-limit-enabled"
                    className="text-sm"
                  >
                    Enabled
                  </Label>
                </div>

                {providerUsageLimitIsEnabled ? (
                  <div className="space-y-5">
                    {renderSlackDestinationField({
                      field: 'providerUsageLimitSlackChannel',
                      inputId: 'provider-usage-limit-slack-channel',
                      label: 'Post alerts to this Slack channel',
                      helperText:
                        'Choose where Roomote should post provider usage warnings.',
                      savedChannelId:
                        settingsQuery.data?.settings
                          .providerUsageLimitSlackChannelId ?? null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .providerUsageLimitDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.providerUsageLimitSlackChannel,
                    })}

                    <div className="space-y-3 md:max-w-md">
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="provider-usage-limit-threshold">
                          Alert threshold
                        </Label>
                        <span className="text-sm font-medium tabular-nums">
                          {formState.providerUsageLimitThreshold}%
                        </span>
                      </div>
                      <Slider
                        id="provider-usage-limit-threshold"
                        min={5}
                        max={95}
                        step={5}
                        value={[formState.providerUsageLimitThreshold]}
                        onValueChange={([threshold]) => {
                          if (threshold === undefined) return;
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  providerUsageLimitThreshold: threshold,
                                }
                              : prev,
                          );
                        }}
                        aria-label="Provider usage alert threshold"
                      />
                      <p className="text-xs text-muted-foreground">
                        Alert when a provider reaches this percentage of its
                        reported quota. Roomote checks hourly and sends one
                        alert per quota cycle, plus a critical alert at 100%.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.sentryTriage}
              isAvailableMatch={availableAutomationMatches.has('sentryTriage')}
              isOpen={openAutomationIds.has('sentryTriage')}
              onOpenChange={(open) => setAutomationOpen('sentryTriage', open)}
              iconEnabled={iconEnabled.sentryTriage}
              debugSection={renderDebugRunsSection('sentryTriage')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip(
                    'sentryTriage',
                    sentryTriageIsEnabled,
                    sentryTriageBlockedReason,
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({
                        automationKey: 'sentry_triage',
                      })
                    }
                    disabled={isRunDisabled(
                      'sentryTriage',
                      sentryTriageIsEnabled,
                      sentryTriageBlockedReason != null,
                    )}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.sentryTriage}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'sentryTriage'
                  }
                  saveDisabled={sentryTriageSaveDisabled}
                  onSave={() => saveAgent('sentryTriage')}
                  onReset={() => resetAgent('sentryTriage')}
                />
              }
            >
              <div className="space-y-5">
                <Select
                  value={formState.sentryTriageFrequency}
                  onValueChange={(value) => {
                    const frequency = value as SentryTriageFrequency;

                    if (
                      !canSelectSentryTriageFrequency({
                        sentryConnected: sentryConnected,
                        frequency,
                      })
                    ) {
                      toast.error(
                        'Configure Sentry in Settings > Integrations before enabling Triage Sentry Issues.',
                      );
                      return;
                    }

                    setFormState((prev) =>
                      prev
                        ? {
                            ...prev,
                            sentryTriageFrequency: frequency,
                          }
                        : prev,
                    );
                  }}
                >
                  <SelectTrigger
                    id="sentry-triage-frequency"
                    aria-label="Triage Sentry Issues schedule"
                    className="w-full md:w-56"
                  >
                    <SelectValue placeholder="Select a schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    {SENTRY_TRIAGE_FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={
                          !canSelectSentryTriageFrequency({
                            sentryConnected: sentryConnected,
                            frequency: option.value,
                          })
                        }
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {!sentryConnected ? (
                  <Alert variant="light" className="md:max-w-160">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <AlertTitle>Connect Sentry first</AlertTitle>
                    <AlertDescription>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <span>
                          Connect the workspace Sentry integration before
                          enabling scheduled Sentry triage.
                        </span>
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={`${SETTINGS_PATHS.integrations}?highlight=sentry-mcp`}
                          >
                            Configure Sentry
                          </a>
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {sentryTriageIsEnabled ? (
                  <div className="space-y-5">
                    {renderSlackDestinationField({
                      field: 'sentryTriageSlackChannel',
                      inputId: 'sentry-triage-slack-channel',
                      label: 'Post follow-up work to this Slack channel',
                      helperText:
                        'Choose where Roomote should post actionable Sentry follow-up work.',
                      savedChannelId:
                        settingsQuery.data?.settings
                          .sentryTriageSlackChannelId ?? null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .sentryTriageDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.sentryTriageSlackChannel,
                    })}

                    <p className="text-xs text-muted-foreground md:max-w-160">
                      Requires Sentry to be configured in Settings &gt;
                      Integrations.
                    </p>

                    <div className="space-y-2">
                      <Label htmlFor="sentry-triage-projects">
                        Project slugs
                      </Label>
                      <Textarea
                        id="sentry-triage-projects"
                        value={formState.sentryTriageProjectSlugs}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  sentryTriageProjectSlugs: event.target.value,
                                }
                              : prev,
                          )
                        }
                        rows={3}
                        placeholder="Optional, one Sentry project slug per line"
                      />
                      <p className="text-xs text-muted-foreground md:max-w-160">
                        Leave blank to scan all projects available to the Sentry
                        token.
                      </p>
                      {fieldErrors.sentryTriageProjectSlugs ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.sentryTriageProjectSlugs}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.suggester}
              isAvailableMatch={availableAutomationMatches.has('suggester')}
              isOpen={openAutomationIds.has('suggester')}
              onOpenChange={(open) => setAutomationOpen('suggester', open)}
              iconEnabled={iconEnabled.suggester}
              disabled={slackAutomationsDisabled}
              debugSection={renderDebugRunsSection('suggester')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip('suggester', suggesterIsEnabled)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({ automationKey: 'suggester' })
                    }
                    disabled={isRunDisabled('suggester', suggesterIsEnabled)}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.suggester}
                  isPending={
                    updateMutation.isPending && savingAutomation === 'suggester'
                  }
                  onSave={() => saveAgent('suggester')}
                  onReset={() => resetAgent('suggester')}
                />
              }
            >
              <div className="space-y-5">
                <Select
                  value={formState.suggesterFrequency}
                  onValueChange={(value) => {
                    setFormState((prev) =>
                      prev
                        ? {
                            ...prev,
                            suggesterFrequency: value as SuggesterFrequency,
                          }
                        : prev,
                    );
                  }}
                >
                  <SelectTrigger
                    id="suggester-frequency"
                    aria-label="Suggest Ideas schedule"
                    className="w-full md:w-56"
                  >
                    <SelectValue placeholder="Select a schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    {SUGGESTER_FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {suggesterIsEnabled ? (
                  <div className="space-y-5">
                    <>
                      {renderSlackDestinationField({
                        field: 'suggesterSlackChannel',
                        inputId: 'suggester-slack-channel',
                        label: 'Post suggestions to this Slack channel',
                        helperText:
                          'Choose where Roomote should post its suggestion digests.',
                        savedChannelId:
                          settingsQuery.data?.settings
                            .suggesterSlackChannelId ?? null,
                        savedDiscordChannelId:
                          settingsQuery.data?.settings
                            .suggesterDiscordChannelId ?? null,
                        warningChannelId:
                          slackChannelAccessWarnings.suggesterSlackChannel,
                        allowTelegram: true,
                        savedTelegramSelected: Boolean(
                          settingsQuery.data?.settings.suggesterTelegramChatId,
                        ),
                        allowTeams: true,
                        savedTeamsSelected: Boolean(
                          settingsQuery.data?.settings.suggesterTeamsChannelId,
                        ),
                      })}

                      <div className="space-y-2">
                        <Label htmlFor="suggester-instructions">
                          Additional instructions
                        </Label>
                        <Textarea
                          id="suggester-instructions"
                          value={formState.suggesterInstructions}
                          onChange={(event) =>
                            setFormState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    suggesterInstructions: event.target.value,
                                  }
                                : prev,
                            )
                          }
                          rows={4}
                          placeholder="Optional guidance for which ideas to prioritize or avoid"
                        />
                        {fieldErrors.suggesterInstructions ? (
                          <p className="text-xs text-destructive">
                            {fieldErrors.suggesterInstructions}
                          </p>
                        ) : null}
                      </div>
                    </>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.announcer}
              isAvailableMatch={availableAutomationMatches.has('announcer')}
              isOpen={openAutomationIds.has('announcer')}
              onOpenChange={(open) => setAutomationOpen('announcer', open)}
              iconEnabled={iconEnabled.announcer}
              disabled={slackAutomationsDisabled}
              debugSection={renderDebugRunsSection('announcer')}
              runAction={
                <BasicTooltip
                  content={getRunTooltip('announcer', announcerIsEnabled)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      triggerMutation.mutate({ automationKey: 'announcer' })
                    }
                    disabled={isRunDisabled('announcer', announcerIsEnabled)}
                  >
                    <Play />
                  </Button>
                </BasicTooltip>
              }
              footer={
                <AutomationFooter
                  isDirty={isDirty.announcer}
                  isPending={
                    updateMutation.isPending && savingAutomation === 'announcer'
                  }
                  onSave={() => saveAgent('announcer')}
                  onReset={() => resetAgent('announcer')}
                />
              }
            >
              <div className="space-y-5">
                <Select
                  value={formState.announcerFrequency}
                  onValueChange={(value) =>
                    setFormState((prev) =>
                      prev
                        ? {
                            ...prev,
                            announcerFrequency: value as AnnouncerFrequency,
                          }
                        : prev,
                    )
                  }
                >
                  <SelectTrigger
                    id="announcer-frequency"
                    aria-label="Summarize Merged PRs schedule"
                    className="w-full md:w-56"
                  >
                    <SelectValue placeholder="Select a schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    {ANNOUNCER_FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {announcerIsEnabled ? (
                  <div className="space-y-5">
                    {renderSlackDestinationField({
                      field: 'announcerSlackChannel',
                      inputId: 'announcer-slack-channel',
                      label: 'Post summaries to this Slack channel',
                      helperText:
                        'Choose where Roomote should post merged-PR summaries.',
                      savedChannelId:
                        settingsQuery.data?.settings.announcerSlackChannelId ??
                        null,
                      savedDiscordChannelId:
                        settingsQuery.data?.settings
                          .announcerDiscordChannelId ?? null,
                      warningChannelId:
                        slackChannelAccessWarnings.announcerSlackChannel,
                    })}

                    <div className="space-y-2">
                      <Label htmlFor="announcer-instructions">
                        Additional instructions
                      </Label>
                      <Textarea
                        id="announcer-instructions"
                        value={formState.announcerInstructions}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  announcerInstructions: event.target.value,
                                }
                              : prev,
                          )
                        }
                        rows={4}
                        placeholder="Optional guidance for summary tone and focus"
                      />
                      {fieldErrors.announcerInstructions ? (
                        <p className="text-xs text-destructive">
                          {fieldErrors.announcerInstructions}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </AutomationCard>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.platformIssueAlerts}
              isAvailableMatch={availableAutomationMatches.has(
                'platformIssueAlerts',
              )}
              isOpen={openAutomationIds.has('platformIssueAlerts')}
              onOpenChange={(open) =>
                setAutomationOpen('platformIssueAlerts', open)
              }
              iconEnabled={iconEnabled.platformIssueAlerts}
              footer={
                <AutomationFooter
                  isDirty={isDirty.platformIssueAlerts}
                  isPending={
                    updateMutation.isPending &&
                    savingAutomation === 'platformIssueAlerts'
                  }
                  onSave={() => saveAgent('platformIssueAlerts')}
                  onReset={() => resetAgent('platformIssueAlerts')}
                />
              }
            >
              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <Switch
                    id="platform-issue-alerts-enabled"
                    checked={formState?.platformIssueAlertsEnabled ?? true}
                    onCheckedChange={(enabled) =>
                      setFormState((prev) =>
                        prev
                          ? { ...prev, platformIssueAlertsEnabled: enabled }
                          : prev,
                      )
                    }
                    aria-label="Alert on Config Errors enabled"
                  />
                  <Label
                    htmlFor="platform-issue-alerts-enabled"
                    className="text-sm"
                  >
                    Alert deployment admins about configuration issues
                  </Label>
                </div>
                {renderSlackDestinationField({
                  field: 'platformIssueSlackChannel',
                  inputId: 'platform-issue-slack-channel',
                  label: 'Post alerts to this Slack channel',
                  helperText:
                    'Choose where Roomote should post configuration issues. Leave empty to use the Manager Channel, then direct-message deployment admins.',
                  reportsToFallbackText:
                    'Reports to deployment admins via direct message (automatic).',
                  savedChannelId:
                    settingsQuery.data?.settings.platformIssueSlackChannelId ??
                    null,
                  savedDiscordChannelId:
                    settingsQuery.data?.settings
                      .platformIssueDiscordChannelId ?? null,
                  warningChannelId:
                    slackChannelAccessWarnings.platformIssueSlackChannel,
                })}
              </div>
            </AutomationCard>
          </div>
        </div>
      )}
    </div>
  );
}

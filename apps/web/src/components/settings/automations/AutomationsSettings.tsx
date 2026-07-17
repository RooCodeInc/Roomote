'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FeatureFlag } from '@roomote/feature-flags';
import {
  type BackgroundAutomationKey,
  type CommunicationProvider,
  communicationProviders,
  CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  DEFAULT_SUGGESTER_ROUTING_MODE,
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
  type SuggesterRoutingMode,
  type TaskState,
  type TaskTrigger,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

import { useConnectSlack } from '@/hooks/slack';
import { useShowDebugUI } from '@/hooks/useShowDebugUI';
import { useAuthorizedUser } from '@/hooks/useUser';
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
import { SlackChannelSelect } from './SlackChannelSelect';

import {
  Alert,
  AlertCircle,
  AlertDescription,
  AlertTitle,
  Badge,
  BasicTooltip,
  BellElectric,
  BrandIcon,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartColumnIncreasing,
  Check,
  ChevronRight,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  GitMergeConflict,
  GitPullRequest,
  Info,
  Input,
  Label,
  Lightbulb,
  Megaphone,
  Play,
  RadioGroup,
  RadioGroupItem,
  RefreshCcw,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SquarePen,
  Slack,
  Spinner,
  Switch,
  Textarea,
  TriangleAlert,
  Users,
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
    | 'channelAutoStartSlackChannels'
    | 'channelAutoStartInstructions'
    | 'managerSlackChannel'
    | 'managerStatsSlackChannel'
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
    | 'sentryTriageDiscordChannel'
    | 'dependabotTriageDiscordChannel'
    | 'codeqlTriageDiscordChannel'
    | 'securityAuditorDiscordChannel'
    | 'codeQualityAuditorDiscordChannel'
    | 'ciFailureTriageDiscordChannel'
    | 'suggesterDiscordChannel'
    | 'announcerDiscordChannel'
    | 'platformIssueDiscordChannel'
    | 'sentryTriageProjectSlugs'
    | 'suggesterInstructions'
    | 'suggesterRoutingInstructions'
    | 'announcerInstructions',
    string
  >
>;

type SuggestionRoutingPreviewRoute = {
  groupLabel: string;
  slackChannelName: string;
  guidance: string;
};

type SlackChannelAccessWarnings = {
  channelAutoStartSlackChannels: string[];
  managerSlackChannel: string | null;
  managerStatsSlackChannel: string | null;
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
  | 'managerStatsSlackChannel'
  | 'sentryTriageSlackChannel'
  | 'dependabotTriageSlackChannel'
  | 'codeqlTriageSlackChannel'
  | 'securityAuditorSlackChannel'
  | 'codeQualityAuditorSlackChannel'
  | 'ciFailureTriageSlackChannel'
  | 'suggesterSlackChannel'
  | 'announcerSlackChannel'
  | 'platformIssueSlackChannel';

const SLACK_DESTINATION_FIELD_AUTOMATION_KEYS = {
  managerStatsSlackChannel: 'manager_stats',
  sentryTriageSlackChannel: 'sentry_triage',
  dependabotTriageSlackChannel: 'dependabot_triage',
  codeqlTriageSlackChannel: 'codeql_triage',
  securityAuditorSlackChannel: 'security_auditor',
  codeQualityAuditorSlackChannel: 'code_quality_auditor',
  ciFailureTriageSlackChannel: 'ci_failure_triage',
  suggesterSlackChannel: 'suggester',
  announcerSlackChannel: 'announcer',
  platformIssueSlackChannel: 'platform_issue_alerts',
} as const satisfies Record<
  AutomationSlackDestinationField,
  BackgroundAutomationKey
>;

const SLACK_DESTINATION_FIELD_AUTOMATION_IDS = {
  managerStatsSlackChannel: 'managerStats',
  sentryTriageSlackChannel: 'sentryTriage',
  dependabotTriageSlackChannel: 'dependabotTriage',
  codeqlTriageSlackChannel: 'codeqlTriage',
  securityAuditorSlackChannel: 'securityAuditor',
  codeQualityAuditorSlackChannel: 'codeQualityAuditor',
  ciFailureTriageSlackChannel: 'ciFailureTriage',
  suggesterSlackChannel: 'suggester',
  announcerSlackChannel: 'announcer',
  platformIssueSlackChannel: 'platformIssueAlerts',
} as const satisfies Record<AutomationSlackDestinationField, AutomationId>;

type AutomationDiscordDestinationField =
  | 'managerStatsDiscordChannel'
  | 'sentryTriageDiscordChannel'
  | 'dependabotTriageDiscordChannel'
  | 'codeqlTriageDiscordChannel'
  | 'securityAuditorDiscordChannel'
  | 'codeQualityAuditorDiscordChannel'
  | 'ciFailureTriageDiscordChannel'
  | 'suggesterDiscordChannel'
  | 'announcerDiscordChannel'
  | 'platformIssueDiscordChannel';

// The form field holding the same automation's Discord destination; the
// destination picker is one-of, so selecting one provider clears the other.
const SLACK_TO_DISCORD_DESTINATION_FIELDS = {
  managerStatsSlackChannel: 'managerStatsDiscordChannel',
  sentryTriageSlackChannel: 'sentryTriageDiscordChannel',
  dependabotTriageSlackChannel: 'dependabotTriageDiscordChannel',
  codeqlTriageSlackChannel: 'codeqlTriageDiscordChannel',
  securityAuditorSlackChannel: 'securityAuditorDiscordChannel',
  codeQualityAuditorSlackChannel: 'codeQualityAuditorDiscordChannel',
  ciFailureTriageSlackChannel: 'ciFailureTriageDiscordChannel',
  suggesterSlackChannel: 'suggesterDiscordChannel',
  announcerSlackChannel: 'announcerDiscordChannel',
  platformIssueSlackChannel: 'platformIssueDiscordChannel',
} as const satisfies Record<
  AutomationSlackDestinationField,
  AutomationDiscordDestinationField
>;

/**
 * Discord options share the Slack destination combobox, so their option ids
 * are prefixed to distinguish them from (unprefixed) Slack channel ids.
 */
export const DISCORD_DESTINATION_OPTION_PREFIX = 'discord:';

type SlackChannelOption = {
  id: string;
  name: string;
  label: string;
  isPrivate?: boolean;
  isMember?: boolean | null;
};

type AutomationDefinition = {
  id: AutomationId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  availability?: 'stable' | 'beta';
  /** Compact label for the chat surfaces the automation can report to. */
  commsBadge?: string;
  /** Compact label for the source-control providers the automation supports. */
  scmBadge?: string;
};

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

const CUSTOM_MANAGER_CHANNEL_SELECT_VALUE = '__custom_manager_channel__';
const CLEAR_MANAGER_CHANNEL_SELECT_VALUE = '__clear_manager_channel__';

const EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS: SlackChannelAccessWarnings = {
  channelAutoStartSlackChannels: [],
  managerSlackChannel: null,
  managerStatsSlackChannel: null,
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
): Pick<AutomationDefinition, 'commsBadge' | 'scmBadge'> {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    return {};
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
    availability: descriptor.availability,
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
      availability: automation.availability,
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
  channelAutoStart: {
    id: 'channelAutoStart',
    label: 'Auto-respond to Slack channels',
    description:
      'Start tasks from selected Slack channels, each with its own custom instructions.',
    icon: Slack,
  },
  managerChannel: {
    id: 'managerChannel',
    label: 'Automation output',
    description:
      'Shared Slack channel for manager-facing Roomote asks, summaries, and alerts.',
    icon: Users,
  },
  managerStats: {
    ...getAutomationDefinition(
      'managerStats',
      'manager_stats',
      ChartColumnIncreasing,
    ),
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
  },
  announcer: {
    ...getAutomationDefinition('announcer', 'announcer', Megaphone),
  },
  platformIssueAlerts: {
    id: 'platformIssueAlerts',
    label: 'Alert on Config Errors',
    description:
      'Alert on Slack or Discord when a task runs into admin-fixable issues.',
    icon: BellElectric,
  },
};

const HASH_ALIAS_TO_AUTOMATION_ID: Record<string, AutomationId> = {
  'auto-respond-channels': 'channelAutoStart',
  autorespondchannels: 'channelAutoStart',
  'auto-start-tasks': 'channelAutoStart',
  channelautostart: 'channelAutoStart',
  'channel-auto-start': 'channelAutoStart',
  'roomote-managers': 'managerChannel',
  managerchannel: 'managerChannel',
  'manager-channel': 'managerChannel',
  'weekly-manager-stats': 'managerStats',
  managerstats: 'managerStats',
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
      relayReviewResultsToTask: boolean;
      relayUsers: Array<{
        userId: string;
        name: string;
        email: string | null;
        imageUrl: string | null;
        relayEnabled: boolean;
      }>;
    };
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
    channelAutoStartSlackChannelNames?: Record<string, string | null>;
    managerSlackChannelId: string | null;
    managerSlackChannelName?: string | null;
    managerStatsFrequency: ManagerStatsFrequency;
    managerStatsSlackChannelId: string | null;
    managerStatsSlackChannelName?: string | null;
    managerStatsDiscordChannelId: string | null;
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
    suggesterInstructions: string | null;
    suggesterRoutingMode: SuggesterRoutingMode;
    suggesterRoutingInstructions: string | null;
    announcerFrequency: AnnouncerFrequency;
    announcerSlackChannelId: string | null;
    announcerSlackChannelName?: string | null;
    announcerDiscordChannelId: string | null;
    announcerInstructions: string | null;
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
  } & ScheduleOnlyAutomationFrequencyState,
): FormState {
  return {
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
    channelAutoStartSlackChannels: settings.channelAutoStartSlackChannels.map(
      ({ channelId, instructions, launchMode, launchCriteria }) => ({
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
    managerSlackChannel:
      settings.managerSlackChannelName ?? settings.managerSlackChannelId ?? '',
    managerStatsFrequency: settings.managerStatsFrequency,
    managerStatsSlackChannel:
      settings.managerStatsSlackChannelName ??
      settings.managerStatsSlackChannelId ??
      '',
    managerStatsDiscordChannel: settings.managerStatsDiscordChannelId ?? '',
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
    suggesterInstructions: settings.suggesterInstructions ?? '',
    suggesterRoutingMode:
      settings.suggesterRoutingMode ?? DEFAULT_SUGGESTER_ROUTING_MODE,
    suggesterRoutingInstructions: settings.suggesterRoutingInstructions ?? '',
    announcerFrequency: settings.announcerFrequency,
    announcerSlackChannel:
      settings.announcerSlackChannelName ??
      settings.announcerSlackChannelId ??
      '',
    announcerDiscordChannel: settings.announcerDiscordChannelId ?? '',
    announcerInstructions: settings.announcerInstructions ?? '',
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
  formState:
    | Pick<
        FormState,
        'platformIssueSlackChannel' | 'platformIssueDiscordChannel'
      >
    | null
    | undefined,
): boolean {
  return Boolean(
    formState?.platformIssueSlackChannel.trim() ||
    formState?.platformIssueDiscordChannel.trim(),
  );
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

export function shouldShowManagerSlackChannelWarning({
  formValue,
  savedChannelId,
  warningChannelId,
  isDirty,
}: {
  formValue: string | null | undefined;
  savedChannelId: string | null | undefined;
  warningChannelId: string | null | undefined;
  isDirty: boolean;
}): boolean {
  const trimmedFormValue = formValue?.trim();

  if (!trimmedFormValue || !warningChannelId) {
    return false;
  }

  if (warningChannelId.toLowerCase() === trimmedFormValue.toLowerCase()) {
    return true;
  }

  return !isDirty && savedChannelId === warningChannelId;
}

export function formatSlackChannelValue(
  value: string | null | undefined,
): string {
  const trimmedValue = value?.trim() ?? '';

  if (!trimmedValue) {
    return '';
  }

  if (trimmedValue.startsWith('#') || /^[CGD][A-Z0-9]+$/i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `#${trimmedValue}`;
}

function matchesSlackChannelOption(
  value: string | null | undefined,
  option: SlackChannelOption,
): boolean {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  return (
    normalizedValue === option.id.toLowerCase() ||
    normalizedValue === option.name.toLowerCase() ||
    normalizedValue === option.label.toLowerCase()
  );
}

export function buildManagerSlackChannelOptions(params: {
  channels: Array<{ id: string; name: string }>;
  selectedValue: string | null | undefined;
}): SlackChannelOption[] {
  const options = params.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    label: `#${channel.name}`,
  }));

  const selectedValue = params.selectedValue?.trim();
  if (
    !selectedValue ||
    options.some((option) => matchesSlackChannelOption(selectedValue, option))
  ) {
    return options;
  }

  return [
    {
      id: selectedValue,
      name: selectedValue.startsWith('#')
        ? selectedValue.slice(1)
        : selectedValue,
      label: formatSlackChannelValue(selectedValue),
    },
    ...options,
  ];
}

export function buildAutomationDiscordDestinationOptions(params: {
  channels: Array<{ id: string; name: string; label: string }>;
  selectedChannelId: string | null | undefined;
  /**
   * The "(Discord)" suffix only disambiguates when Slack channels can appear
   * in the same picker; on a Discord-only deployment it is noise.
   */
  includeProviderSuffix: boolean;
}): SlackChannelOption[] {
  const suffix = params.includeProviderSuffix ? ' (Discord)' : '';
  const options = params.channels.map((channel) => ({
    id: `${DISCORD_DESTINATION_OPTION_PREFIX}${channel.id}`,
    name: channel.name,
    label: `${channel.label}${suffix}`,
  }));

  const selectedChannelId = params.selectedChannelId?.trim();
  const selectedOptionId = selectedChannelId
    ? `${DISCORD_DESTINATION_OPTION_PREFIX}${selectedChannelId}`
    : null;

  if (
    !selectedOptionId ||
    options.some((option) => option.id === selectedOptionId)
  ) {
    return options;
  }

  // Keep a saved channel selectable/displayable even when the cached channel
  // catalog no longer lists it (or has not loaded yet).
  return [
    {
      id: selectedOptionId,
      name: selectedChannelId!,
      label: `#${selectedChannelId}${suffix}`,
    },
    ...options,
  ];
}

export function buildCustomManagerSlackChannelOption(params: {
  searchValue: string | null | undefined;
  options: SlackChannelOption[];
}): SlackChannelOption | null {
  const searchValue = params.searchValue?.trim();

  if (
    !searchValue ||
    params.options.some((option) =>
      matchesSlackChannelOption(searchValue, option),
    )
  ) {
    return null;
  }

  const label = formatSlackChannelValue(searchValue);

  return {
    id: searchValue,
    name: label.startsWith('#') ? label.slice(1) : label,
    label,
  };
}

export function isManagerChannelSelectionDisabled(params: {
  slackConnected: boolean;
  isFetching: boolean;
  hasValue: boolean;
  isConfigured: boolean;
}): boolean {
  return (
    params.isFetching ||
    (!params.slackConnected && !params.hasValue && !params.isConfigured)
  );
}

function hasConfiguredChannelAutoStartRows(
  rows: ChannelAutoStartFormRow[] | null | undefined,
): boolean {
  return (rows ?? []).some((row) => Boolean(row.slackChannel.trim()));
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
    <div className="space-y-4">
      {Array.from({ length: 6 }).map((_, index) => (
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
}: {
  destination: ResolvedAutomationDestinationSummary | null | undefined;
}) {
  if (!destination) {
    return (
      <p className="text-xs text-muted-foreground md:max-w-160">
        Reports to: not configured — set a Manager Channel.
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
      <AutomationReportsToLine destination={destination} />
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
                <Button asChild variant="outline" size="sm">
                  <Link href={`/task/${run.taskId}`}>Open task</Link>
                </Button>
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
  runAction?: React.ReactNode;
  debugSection?: React.ReactNode;
  footer?: React.ReactNode;
  disabled?: boolean;
  alwaysOpen?: boolean;
  children: React.ReactNode;
}) {
  const Icon = automation.icon;
  const open = !disabled && (alwaysOpen || isOpen);
  const content = (
    <>
      <CardContent className="space-y-4 pl-4 pt-5 md:pl-8">
        {children}
        {debugSection}
      </CardContent>
      {footer ? (
        <div className="flex items-center md:pl-8 mt-4">{footer}</div>
      ) : null}
    </>
  );

  return (
    <div
      id={automation.id}
      className="scroll-mt-24"
      aria-disabled={disabled || undefined}
    >
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) => {
          if (!disabled) {
            onOpenChange(nextOpen);
          }
        }}
      >
        <Card
          className={cn(
            'gap-0 overflow-hidden px-4 py-4',
            disabled && 'opacity-50',
          )}
        >
          <CardHeader className="p-0">
            <div className="flex items-start gap-3">
              {alwaysOpen ? (
                <div className="flex items-start gap-2 grow group pl-2">
                  <Icon
                    className={cn(
                      'mt-1 size-5 shrink-0',
                      iconEnabled
                        ? 'text-accent-foreground'
                        : 'text-muted-foreground/50',
                    )}
                  />
                  <div className="min-w-0 flex-1 space-y-1 pr-2">
                    <CardTitle className="text-base leading-6 group-hover:text-accent-foreground">
                      <AutomationTitle automation={automation} />
                    </CardTitle>
                    <p className="text-sm opacity-60 group-hover:text-accent-foreground">
                      {automation.description}
                    </p>
                  </div>
                </div>
              ) : disabled ? (
                <div className="flex items-start gap-2 grow cursor-not-allowed">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${automation.label} is disabled until a Manager Channel is saved`}
                    className="mt-0.5 shrink-0"
                    disabled
                  >
                    <ChevronRight />
                  </Button>
                  <span className="shrink-0 p-1 -mt-0.5 rounded-full size-8 inline-flex items-center justify-center bg-transparent">
                    <Icon className="size-5 text-muted-foreground/50" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1 pr-2">
                    <CardTitle className="text-base leading-6">
                      <AutomationTitle automation={automation} />
                    </CardTitle>
                    <p className="text-sm opacity-60">
                      {automation.description}
                    </p>
                  </div>
                </div>
              ) : (
                <CollapsibleTrigger asChild>
                  <div className="flex items-start gap-2 cursor-pointer grow group">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${automation.label}`}
                      className="group mt-0.5 shrink-0"
                    >
                      <ChevronRight className="transition-transform duration-200 group-data-[state=open]:rotate-90" />
                    </Button>
                    <span
                      className={cn(
                        'shrink-0 p-1 -mt-0.5 rounded-full size-8 inline-flex items-center justify-center',
                        iconEnabled ? 'bg-accent-foreground' : 'bg-transparent',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-5',
                          iconEnabled
                            ? 'text-black'
                            : 'text-muted-foreground/50',
                        )}
                      />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1 pr-2">
                      <CardTitle className="text-base leading-6 group-hover:text-accent-foreground">
                        <AutomationTitle automation={automation} />
                      </CardTitle>
                      <p className="text-sm opacity-60 group-hover:text-accent-foreground">
                        {automation.description}
                      </p>
                    </div>
                  </div>
                </CollapsibleTrigger>
              )}
              {runAction && !disabled ? (
                <div className="shrink-0">{runAction}</div>
              ) : null}
            </div>
          </CardHeader>
          {alwaysOpen && !disabled ? (
            content
          ) : !disabled ? (
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-slideUp data-[state=open]:animate-slideDown">
              {content}
            </CollapsibleContent>
          ) : null}
        </Card>
      </Collapsible>
    </div>
  );
}

function AutomationTitle({ automation }: { automation: AutomationDefinition }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{automation.label}</span>
      {automation.availability === 'beta' ? (
        <Badge variant="secondary">Beta</Badge>
      ) : null}
      {automation.commsBadge ? (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {automation.commsBadge}
        </Badge>
      ) : null}
      {automation.scmBadge ? (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {automation.scmBadge}
        </Badge>
      ) : null}
    </span>
  );
}

function ScheduledAutomationCard<TFrequency extends string>({
  automation,
  isOpen,
  onOpenChange,
  iconEnabled,
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
  const user = useAuthorizedUser();
  const { isDebugUIVisible } = useShowDebugUI();
  const showAutomationDebugRuns = isDebugUIVisible;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [formState, setFormState] = useState<FormState | null>(null);
  const [savedState, setSavedState] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [suggesterRoutingPreview, setSuggesterRoutingPreview] = useState<
    SuggestionRoutingPreviewRoute[] | null
  >(null);
  const [isEditingSuggesterRouting, setIsEditingSuggesterRouting] =
    useState(true);
  const [slackChannelAccessWarnings, setSlackChannelAccessWarnings] =
    useState<SlackChannelAccessWarnings>(EMPTY_SLACK_CHANNEL_ACCESS_WARNINGS);
  const [managerSlackChannelId, setManagerSlackChannelId] = useState<
    string | null
  >(null);
  const [savingAutomation, setSavingAutomation] = useState<AutomationId | null>(
    null,
  );
  const [openAutomationIds, setOpenAutomationIds] = useState<Set<AutomationId>>(
    () => new Set(),
  );
  const [isEditingManagerChannel, setIsEditingManagerChannel] = useState(false);
  const [isEnteringCustomManagerChannel, setIsEnteringCustomManagerChannel] =
    useState(false);
  const formStateRef = useRef<FormState | null>(null);
  const savedStateRef = useRef<FormState | null>(null);
  const didApplyInitialHashRef = useRef(false);
  const suggestionRoutingEnabled =
    user.featureFlags[FeatureFlag.SuggestionRouting] === true;

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

          if (result.fieldErrors.managerSlackChannel) {
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
          return;
        }

        setFieldErrors({});
        if (savingAutomation === 'suggester') {
          const nextRoutingPreview = result.suggesterRoutingPreview ?? null;
          setSuggesterRoutingPreview(nextRoutingPreview);
          setIsEditingSuggesterRouting(
            !(
              result.settings.suggesterRoutingMode ===
                'group_by_instructions' && nextRoutingPreview
            ),
          );
        }
        setSlackChannelAccessWarnings(result.slackChannelAccessWarnings);
        setManagerSlackChannelId(result.settings.managerSlackChannelId);
        const mapped = mapSettingsToFormState({
          ...result.settings,
          channelAutoStartSlackChannelNames:
            result.slackChannelDisplayNames.channelAutoStartSlackChannels,
          managerSlackChannelName:
            result.slackChannelDisplayNames.managerSlackChannel,
          managerStatsSlackChannelName:
            result.slackChannelDisplayNames.managerStatsSlackChannel,
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

        if (savingAutomation === 'managerChannel') {
          setIsEditingManagerChannel(false);
          setIsEnteringCustomManagerChannel(false);
        }

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
            toast.success(`${automationLabel} started a task.`, {
              action: {
                label: 'Open task',
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
        channelAutoStart: false,
        managerChannel: false,
        managerStats: false,
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

      if (automationId === 'managerChannel') {
        setIsEnteringCustomManagerChannel(false);
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
  const githubInvocationIdentity =
    commsStatus.data?.invocationIdentities.find(
      (identity) => identity.provider === 'github',
    ) ?? null;
  const slackAppMention =
    slackInvocationIdentity?.mentionText ??
    slackInvocationIdentity?.nativeMention ??
    'the Slack app';
  const githubAppMention =
    githubInvocationIdentity?.mentionText ?? 'the GitHub app';
  const channelAutoStartLaunchModeOptions =
    CHANNEL_AUTO_START_LAUNCH_MODE_OPTIONS;
  const showChannelAutoStartLaunchModePicker = false;
  const reviewerIsEnabled = formState?.reviewerEnabled ?? false;
  const reviewerReviewsAllPrs =
    formState?.reviewerReviewAllPullRequestAuthors ?? false;
  const conflictResolverIsEnabled =
    formState?.conflictResolverFrequency !== 'off';
  const channelAutoStartIsEnabled = hasConfiguredChannelAutoStartRows(
    formState?.channelAutoStartSlackChannels,
  );
  const availableAutoRespondChannelTemplates = useMemo(
    () =>
      getAvailableAutoRespondChannelTemplates(
        formState?.channelAutoStartSlackChannels,
      ),
    [formState?.channelAutoStartSlackChannels],
  );
  const managerChannelIsEnabled = Boolean(
    formState?.managerSlackChannel.trim(),
  );
  const managerChannelConfigured = Boolean(managerSlackChannelId);
  const managerChannelOptions = useMemo(
    () =>
      buildManagerSlackChannelOptions({
        channels: slackChannelsQuery.data?.channels ?? [],
        selectedValue: null,
      }),
    [slackChannelsQuery.data?.channels],
  );
  const selectedManagerChannelOption =
    managerChannelOptions.find((option) =>
      matchesSlackChannelOption(formState?.managerSlackChannel, option),
    ) ?? null;
  const managerChannelHasValue = Boolean(formState?.managerSlackChannel.trim());
  const showCustomManagerChannelInput =
    isEnteringCustomManagerChannel ||
    (managerChannelHasValue && !selectedManagerChannelOption);
  const slackChannelChoices = useMemo(
    () => slackChannelsQuery.data?.channels ?? [],
    [slackChannelsQuery.data?.channels],
  );
  const managerChannelSelectionDisabled = isManagerChannelSelectionDisabled({
    slackConnected: capabilities?.slackConnected === true,
    isFetching: slackChannelsQuery.isFetching,
    hasValue: managerChannelHasValue,
    isConfigured: managerChannelConfigured,
  });
  const managerChannelSelectLabel = showCustomManagerChannelInput
    ? formatSlackChannelValue(formState?.managerSlackChannel) ||
      'Private or manual channel'
    : selectedManagerChannelOption?.label || 'Select a Slack channel';
  const managerChannelSelectValue = showCustomManagerChannelInput
    ? CUSTOM_MANAGER_CHANNEL_SELECT_VALUE
    : selectedManagerChannelOption?.id;
  const managerStatsIsEnabled = formState?.managerStatsFrequency !== 'off';
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
  const showManagerSlackChannelWarning = shouldShowManagerSlackChannelWarning({
    formValue: formState?.managerSlackChannel,
    savedChannelId: managerSlackChannelId,
    warningChannelId: slackChannelAccessWarnings.managerSlackChannel,
    isDirty: isDirty.managerChannel,
  });
  const showChannelAutoStartSlackChannelWarning =
    shouldShowChannelAutoStartWarning({
      formRows: formState?.channelAutoStartSlackChannels,
      savedChannelIds:
        settingsQuery.data?.settings.channelAutoStartSlackChannels.map(
          ({ channelId }) => channelId,
        ) ?? [],
      warningChannelIds:
        slackChannelAccessWarnings.channelAutoStartSlackChannels,
      isDirty: isDirty.channelAutoStart,
    });
  const slackWorkflowLaunchUrl = buildSlackWorkflowLaunchUrl(
    capabilities?.slackWorkspaceDomain,
  );
  const showManagerChannelMigrationNote =
    !formState?.managerSlackChannel &&
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
  const renderSlackDestinationField = useCallback(
    ({
      field,
      inputId,
      label,
      helperText,
      savedChannelId,
      savedDiscordChannelId,
      warningChannelId,
    }: {
      field: AutomationSlackDestinationField;
      inputId: string;
      label: string;
      helperText?: string;
      savedChannelId: string | null;
      savedDiscordChannelId: string | null;
      warningChannelId: string | null;
    }) => {
      const discordField = SLACK_TO_DISCORD_DESTINATION_FIELDS[field];
      const value = formState?.[field] ?? '';
      const discordValue = formState?.[discordField] ?? '';
      const showDiscordOptions = discordConnected || Boolean(discordValue);
      // The historical labels say "Slack channel"; once Discord channels are
      // offered in the same picker that wording reads as a bug.
      const effectiveLabel = showDiscordOptions
        ? label.replace(/ Slack channel$/u, ' channel')
        : label;
      const options = [
        ...buildSlackDestinationOptions(value),
        ...(showDiscordOptions
          ? buildAutomationDiscordDestinationOptions({
              channels: discordChannelsQuery.data?.channels ?? [],
              selectedChannelId: discordValue || null,
              includeProviderSuffix: slackConnected,
            })
          : []),
      ];
      // One-of destination: a selected Discord channel wins the combobox
      // value; picking one provider clears the other on change.
      const selectedValue = discordValue
        ? `${DISCORD_DESTINATION_OPTION_PREFIX}${discordValue}`
        : value || null;

      return (
        <AutomationSlackDestinationInput
          inputId={inputId}
          label={effectiveLabel}
          helperText={helperText}
          value={selectedValue}
          options={options}
          disabled={isManagerChannelSelectionDisabled({
            slackConnected: slackConnected || discordConnected,
            isFetching:
              slackChannelsQuery.isFetching || discordChannelsQuery.isFetching,
            hasValue: Boolean(value.trim()) || Boolean(discordValue.trim()),
            isConfigured:
              Boolean(savedChannelId) || Boolean(savedDiscordChannelId),
          })}
          discordConnected={discordConnected}
          destination={
            settingsQuery.data?.resolvedDestinations[
              SLACK_DESTINATION_FIELD_AUTOMATION_KEYS[field]
            ]
          }
          slackAppMention={slackAppMention}
          showWarning={
            !discordValue &&
            shouldShowManagerSlackChannelWarning({
              formValue: value,
              savedChannelId,
              warningChannelId,
              isDirty: isDirty[SLACK_DESTINATION_FIELD_AUTOMATION_IDS[field]],
            })
          }
          error={fieldErrors[field] ?? fieldErrors[discordField]}
          onChange={(nextValue) =>
            setFormState((prev) => {
              if (!prev) {
                return prev;
              }

              if (nextValue?.startsWith(DISCORD_DESTINATION_OPTION_PREFIX)) {
                return {
                  ...prev,
                  [field]: '',
                  [discordField]: nextValue.slice(
                    DISCORD_DESTINATION_OPTION_PREFIX.length,
                  ),
                };
              }

              return {
                ...prev,
                [field]: nextValue ?? '',
                [discordField]: '',
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
    channelAutoStart: channelAutoStartIsEnabled,
    managerChannel: managerChannelIsEnabled,
    managerStats: managerStatsIsEnabled,
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
  const savedManagerChannelLabel = (() => {
    const channelFromList = slackChannelChoices.find(
      (channel) => channel.id === managerSlackChannelId,
    );
    if (channelFromList) {
      return `#${channelFromList.name}`;
    }

    const value = formatSlackChannelValue(savedState?.managerSlackChannel);
    if (!value) {
      return '#channel';
    }
    return value;
  })();
  const showManagerChannelForm =
    !managerChannelConfigured ||
    isEditingManagerChannel ||
    isDirty.managerChannel;

  return (
    <div className="space-y-4">
      {!settingsQuery.isPending &&
      capabilities &&
      !capabilities.slackConnected ? (
        <Alert>
          <AlertDescription>
            <div className="flex items-center gap-3">
              <AlertCircle className="size-4" />
              <span>
                You need to connect Slack for automations that post updates into
                channels.
              </span>
              <Button
                size="sm"
                onClick={() => connectSlack.mutate()}
                disabled={connectSlack.isPending}
              >
                <Slack />
                {connectSlack.isPending ? 'Connecting...' : 'Connect Slack'}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

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

      {fieldErrors.managerSlackChannel ? (
        <Alert variant="destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <AlertTitle>Manager Channel required</AlertTitle>
          <AlertDescription>{fieldErrors.managerSlackChannel}</AlertDescription>
        </Alert>
      ) : null}

      {settingsQuery.isPending || !formState ? (
        <LoadingSkeleton />
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">
              Slack automations
            </h2>

            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.channelAutoStart}
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
                rows={formState.channelAutoStartSlackChannels}
                launchModeOptions={channelAutoStartLaunchModeOptions}
                showLaunchModePicker={showChannelAutoStartLaunchModePicker}
                availableTemplates={availableAutoRespondChannelTemplates}
                isEnabled={channelAutoStartIsEnabled}
                warning={
                  showChannelAutoStartSlackChannelWarning ? (
                    <SlackChannelAccessWarning
                      slackAppMention={slackAppMention}
                    />
                  ) : undefined
                }
                channelFieldError={fieldErrors.channelAutoStartSlackChannels}
                instructionsFieldError={
                  fieldErrors.channelAutoStartInstructions
                }
                onRowsChange={(rows) =>
                  setFormState((prev) =>
                    prev
                      ? {
                          ...prev,
                          channelAutoStartSlackChannels: rows,
                        }
                      : prev,
                  )
                }
              />
            </AutomationCard>

            <h2 className="pt-2 text-base font-semibold text-foreground">
              Automations for Roomote Managers
            </h2>

            <div id="managerChannel" className="scroll-mt-24 space-y-2 my-8">
              {showManagerChannelForm ? (
                <>
                  <Label htmlFor="manager-channel">
                    Where should Roomote post manager-facing updates?
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Make sure {slackAppMention} is added to the channel.
                  </p>
                  <div className="max-w-md space-y-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={managerChannelSelectValue}
                        onValueChange={(value) => {
                          if (value === CLEAR_MANAGER_CHANNEL_SELECT_VALUE) {
                            setIsEnteringCustomManagerChannel(false);
                            setFormState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    managerSlackChannel: '',
                                  }
                                : prev,
                            );
                            return;
                          }

                          if (value === CUSTOM_MANAGER_CHANNEL_SELECT_VALUE) {
                            setIsEnteringCustomManagerChannel(true);
                            setFormState((prev) =>
                              prev && selectedManagerChannelOption
                                ? {
                                    ...prev,
                                    managerSlackChannel: '',
                                  }
                                : prev,
                            );
                            return;
                          }

                          const selectedChannel = managerChannelOptions.find(
                            (channel) => channel.id === value,
                          );

                          if (!selectedChannel) {
                            return;
                          }

                          setIsEnteringCustomManagerChannel(false);
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  managerSlackChannel: selectedChannel.label,
                                }
                              : prev,
                          );
                        }}
                        disabled={managerChannelSelectionDisabled}
                      >
                        <SelectTrigger
                          id="manager-channel"
                          aria-label="Select manager Slack channel"
                          autoFocus={isEditingManagerChannel}
                          className="w-full"
                        >
                          <span className="truncate text-left">
                            {managerChannelSelectLabel}
                          </span>
                        </SelectTrigger>
                        <SelectContent align="start">
                          {managerChannelHasValue ? (
                            <>
                              <SelectItem
                                value={CLEAR_MANAGER_CHANNEL_SELECT_VALUE}
                              >
                                Clear selection
                              </SelectItem>
                              <SelectSeparator />
                            </>
                          ) : null}
                          {slackChannelsQuery.isPending ? (
                            <SelectItem value="__loading__" disabled>
                              Loading channels...
                            </SelectItem>
                          ) : slackChannelsQuery.isError ? (
                            <SelectItem value="__error__" disabled>
                              Could not load channels. Try refreshing.
                            </SelectItem>
                          ) : managerChannelOptions.length > 0 ? (
                            managerChannelOptions.map((channel) => (
                              <SelectItem key={channel.id} value={channel.id}>
                                {channel.label}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="__empty__" disabled>
                              No channels found.
                            </SelectItem>
                          )}
                          <SelectSeparator />
                          <SelectItem
                            value={CUSTOM_MANAGER_CHANNEL_SELECT_VALUE}
                          >
                            Private or manual channel
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {managerChannelOptions.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Refresh Slack channels"
                          title="Refresh Slack channels"
                          disabled={
                            !capabilities?.slackConnected ||
                            slackChannelsQuery.isFetching
                          }
                          onClick={() => {
                            void slackChannelsQuery.refetch();
                          }}
                        >
                          <RefreshCcw
                            className={cn(
                              slackChannelsQuery.isFetching && 'animate-spin',
                            )}
                          />
                        </Button>
                      )}
                    </div>
                    {showCustomManagerChannelInput ? (
                      <Input
                        value={formState.managerSlackChannel}
                        onChange={(event) => {
                          setIsEnteringCustomManagerChannel(true);
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  managerSlackChannel: event.target.value,
                                }
                              : prev,
                          );
                        }}
                        placeholder="Enter a private channel name or Slack channel ID"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Private channels may not appear in the list. Use the manual
                    option to paste a private channel name or raw Slack channel
                    ID.
                  </p>
                  {showManagerSlackChannelWarning ? (
                    <SlackChannelAccessWarning
                      slackAppMention={slackAppMention}
                    />
                  ) : null}
                  {fieldErrors.managerSlackChannel ? (
                    <p className="text-xs text-destructive">
                      {fieldErrors.managerSlackChannel}
                    </p>
                  ) : null}
                  {showManagerChannelMigrationNote ? (
                    <Alert variant="light">
                      <AlertDescription>
                        Some older automations still point at different Slack
                        channels. Pick the shared Manager Channel here to
                        migrate future manager-facing posts onto one
                        destination.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex items-center gap-2 pt-2">
                    <AutomationFooter
                      isDirty={isDirty.managerChannel}
                      isPending={
                        updateMutation.isPending &&
                        savingAutomation === 'managerChannel'
                      }
                      onSave={() => saveAgent('managerChannel')}
                      onReset={() => {
                        resetAgent('managerChannel');
                        if (managerChannelConfigured) {
                          setIsEditingManagerChannel(false);
                        }
                      }}
                    />
                    {managerChannelConfigured &&
                    isEditingManagerChannel &&
                    !isDirty.managerChannel ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsEditingManagerChannel(false)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Posting manager-facing updates to{' '}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 align-baseline text-sm font-normal"
                    onClick={() => setIsEditingManagerChannel(true)}
                  >
                    {savedManagerChannelLabel}
                    <SquarePen className="size-3.5" />
                  </Button>
                </p>
              )}
            </div>
          </div>

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.managerStats}
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
                    triggerMutation.mutate({ automationKey: 'manager_stats' })
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
                      settingsQuery.data?.settings.managerStatsSlackChannelId ??
                      null,
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

          <>
            <AutomationCard
              automation={AUTOMATION_DEFINITIONS.sentryTriage}
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
                      triggerMutation.mutate({ automationKey: 'sentry_triage' })
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

            <ScheduledAutomationCard
              automation={AUTOMATION_DEFINITIONS.dependabotTriage}
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

            {SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => {
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
          </>

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.suggester}
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
                  setSuggesterRoutingPreview(null);
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
                  {!suggestionRoutingEnabled ? (
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
                  ) : (
                    <>
                      <RadioGroup
                        value={formState.suggesterRoutingMode}
                        onValueChange={(value) => {
                          setSuggesterRoutingPreview(null);
                          setIsEditingSuggesterRouting(true);
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  suggesterRoutingMode:
                                    value as SuggesterRoutingMode,
                                }
                              : prev,
                          );
                        }}
                        className="space-y-2"
                      >
                        <div className="space-y-2">
                          <Label
                            htmlFor="suggester-routing-manager"
                            className="flex items-center gap-2 cursor-pointer font-normal"
                          >
                            <RadioGroupItem
                              id="suggester-routing-manager"
                              value="manager_channel"
                            />
                            <span>
                              Post all suggestions to the manager channel
                            </span>
                          </Label>
                          {formState.suggesterRoutingMode ===
                          'manager_channel' ? (
                            <div className="space-y-2 pl-6">
                              <Textarea
                                id="suggester-instructions"
                                value={formState.suggesterInstructions}
                                onChange={(event) =>
                                  setFormState((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          suggesterInstructions:
                                            event.target.value,
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
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          <Label
                            htmlFor="suggester-routing-grouped"
                            className="flex items-center gap-2 cursor-pointer font-normal"
                          >
                            <RadioGroupItem
                              id="suggester-routing-grouped"
                              value="group_by_instructions"
                            />
                            <span>
                              Group suggestions and post them in different
                              channels
                            </span>
                          </Label>
                          {formState.suggesterRoutingMode ===
                          'group_by_instructions' ? (
                            <div className="space-y-3">
                              <div className="space-y-2 pl-6">
                                {suggesterRoutingPreview &&
                                !isEditingSuggesterRouting ? (
                                  <>
                                    <table className="w-full border-collapse text-left">
                                      <thead>
                                        <tr className="border-b border-border/70">
                                          <th className="px-0 py-2 text-sm font-medium">
                                            Group
                                          </th>
                                          <th className="px-0 py-2 text-sm font-medium">
                                            Description
                                          </th>
                                          <th className="px-0 py-2 text-sm font-medium">
                                            Channel
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {suggesterRoutingPreview.map(
                                          (route) => (
                                            <tr
                                              key={`${route.groupLabel}-${route.slackChannelName}`}
                                              className="border-b border-border/50 last:border-0"
                                            >
                                              <td className="px-0 py-3 text-sm">
                                                {route.groupLabel}
                                              </td>
                                              <td className="px-0 py-3 text-sm text-muted-foreground">
                                                {route.guidance}
                                              </td>
                                              <td className="px-0 py-3 text-sm font-mono">
                                                {route.slackChannelName}
                                              </td>
                                            </tr>
                                          ),
                                        )}
                                      </tbody>
                                    </table>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      onClick={() =>
                                        setIsEditingSuggesterRouting(true)
                                      }
                                    >
                                      Edit
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <p className="text-sm text-muted-foreground md:max-w-180">
                                      Describe how to group ideas (eg by type,
                                      repo, module) and in what Slack channel to
                                      post them
                                    </p>
                                    <Textarea
                                      id="suggester-routing-instructions"
                                      value={
                                        formState.suggesterRoutingInstructions
                                      }
                                      onChange={(event) => {
                                        setSuggesterRoutingPreview(null);
                                        setIsEditingSuggesterRouting(true);
                                        setFormState((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                suggesterRoutingInstructions:
                                                  event.target.value,
                                              }
                                            : prev,
                                        );
                                      }}
                                      rows={8}
                                      placeholder={`Ideas about incidents, reliability, alerts, and monitoring -> #eng-infra
Ideas about product polish, UX gaps, and onboarding friction -> #product-eng
If unclear, send to manager channel.`}
                                    />
                                    {fieldErrors.suggesterRoutingInstructions ? (
                                      <p className="text-xs text-destructive">
                                        {
                                          fieldErrors.suggesterRoutingInstructions
                                        }
                                      </p>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </RadioGroup>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </AutomationCard>

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.announcer}
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
                      settingsQuery.data?.settings.announcerDiscordChannelId ??
                      null,
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

          <h2 className="pt-2 text-base font-semibold text-foreground">
            Other automations
          </h2>

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.reviewer}
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
                  Enable Code Reviews
                </Label>
              </div>

              {reviewerIsEnabled ? (
                <div className="space-y-5">
                  <Alert variant="light" className="md:max-w-160">
                    <Info className="mt-0.5 size-4 shrink-0 text-foreground" />
                    <AlertTitle>Which PRs get reviewed?</AlertTitle>
                    <AlertDescription>
                      <div className="space-y-2 text-muted-foreground">
                        <p>
                          When background auto-review is on, reviews run on{' '}
                          {reviewerReviewsAllPrs
                            ? 'all pull requests in connected repositories'
                            : `pull requests opened by ${PRODUCT_NAME}`}
                          {formState.reviewerReviewOnCommit
                            ? ' as they open or receive new commits.'
                            : '. Right now, Review Code only runs when someone mentions it on a PR.'}
                        </p>
                        {formState.reviewerReviewOnCommit ? (
                          <p>
                            {formState.reviewerReviewDraftPrs
                              ? 'Draft PRs are included in automatic reviews.'
                              : 'Draft PRs wait until they are marked ready for review.'}
                          </p>
                        ) : null}
                        <p>
                          {reviewerReviewsAllPrs
                            ? 'You can also comment'
                            : 'For PRs outside that scope, comment'}{' '}
                          <span className="font-medium text-foreground">
                            {githubAppMention} review this PR
                          </span>{' '}
                          to request an on-demand review.
                        </p>
                      </div>
                    </AlertDescription>
                  </Alert>

                  <div className="space-y-6 pt-3">
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
                          Auto-review on open and new commits
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Turn this off to keep Review Code background work
                          disabled.
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
                          Keep draft pull requests in scope before they are
                          marked ready for review when Review Code is enabled.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="space-y-1">
                        <p
                          id="reviewer-author-scope-label"
                          className="text-sm font-medium"
                        >
                          Which PRs get automatic reviews?
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Choose whether automatic reviews stay limited to PRs
                          created by {PRODUCT_NAME}, or include PRs from
                          everyone.
                        </p>
                      </div>
                      <RadioGroup
                        aria-labelledby="reviewer-author-scope-label"
                        value={
                          formState.reviewerReviewAllPullRequestAuthors
                            ? 'all_authors'
                            : 'roomote_only'
                        }
                        onValueChange={(value) =>
                          setFormState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  reviewerReviewAllPullRequestAuthors:
                                    value === 'all_authors',
                                }
                              : prev,
                          )
                        }
                        className="space-y-3"
                      >
                        <div className="flex items-start gap-2">
                          <RadioGroupItem
                            className="mt-1"
                            id="reviewer-scope-roomote-only"
                            value="roomote_only"
                          />
                          <div className="space-y-1">
                            <Label
                              htmlFor="reviewer-scope-roomote-only"
                              className="text-sm font-medium cursor-pointer"
                            >
                              Only PRs created by {PRODUCT_NAME}
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              Automatic reviews stay limited to pull requests
                              opened by {PRODUCT_NAME}.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          <RadioGroupItem
                            className="mt-1"
                            id="reviewer-scope-all-authors"
                            value="all_authors"
                          />
                          <div className="space-y-1">
                            <Label
                              htmlFor="reviewer-scope-all-authors"
                              className="text-sm font-medium cursor-pointer"
                            >
                              PRs from everyone
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              Include pull requests opened by people or bots
                              outside {PRODUCT_NAME}.
                            </p>
                          </div>
                        </div>
                      </RadioGroup>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </AutomationCard>

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.conflictResolver}
            isOpen={openAutomationIds.has('conflictResolver')}
            onOpenChange={(open) => setAutomationOpen('conflictResolver', open)}
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
                        {CONFLICT_RESOLVER_MAX_PR_AGE_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={String(option.value)}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
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

          <AutomationCard
            automation={AUTOMATION_DEFINITIONS.platformIssueAlerts}
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
              {renderSlackDestinationField({
                field: 'platformIssueSlackChannel',
                inputId: 'platform-issue-slack-channel',
                label: 'Post alerts to this Slack channel',
                helperText:
                  'Choose where Roomote should post configuration issues that need an admin. Leave empty to use the Manager Channel.',
                savedChannelId:
                  settingsQuery.data?.settings.platformIssueSlackChannelId ??
                  null,
                savedDiscordChannelId:
                  settingsQuery.data?.settings.platformIssueDiscordChannelId ??
                  null,
                warningChannelId:
                  slackChannelAccessWarnings.platformIssueSlackChannel,
              })}
            </div>
          </AutomationCard>

          {!slackAutomationsDisabled ? (
            <Alert variant="light">
              <Lightbulb className="mt-0.5 size-5 shrink-0 text-foreground" />
              <AlertTitle>Wanna automate even more?</AlertTitle>
              <AlertDescription>
                <div>
                  <p className="text-muted-foreground">
                    Just use Slack&apos;s own{' '}
                    <a
                      href={slackWorkflowLaunchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline underline-offset-4 hover:text-foreground/80"
                    >
                      workflows
                    </a>
                    , finishing with{' '}
                    <span className="font-medium text-foreground">
                      {slackAppMention}
                    </span>{' '}
                    mentions, to get it working on whatever you want. Some
                    ideas:
                  </p>
                  <ul className="list-disc space-y-1 pl-5 pt-1 text-sm text-muted-foreground">
                    <li>
                      Pipe operational requests from a ticketing system into
                      Roomote tasks
                    </li>
                    <li>
                      Get diagnostics (or PRs) for bugs posted onto a bugs
                      channel
                    </li>
                    <li>Enable feature flags as requests come in</li>
                  </ul>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      )}
    </div>
  );
}

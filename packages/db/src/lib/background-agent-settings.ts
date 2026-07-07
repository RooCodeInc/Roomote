import { eq } from 'drizzle-orm';

import {
  type BackgroundAutomationManagerChannelKind,
  type BackgroundAutomationKey,
  BACKGROUND_AUTOMATION_KEYS,
  type BackgroundAutomationProvider,
  type BackgroundAutomationTargetKind,
  type CodeQualityAuditorFrequency,
  type DependabotTriageFrequency,
  DEFAULT_SUGGESTER_ROUTING_MODE,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  type ConflictResolverMaxPrAgeDays,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  type ConflictResolverFrequency,
  type CoachFrequency,
  type SuggesterFrequency,
  isConflictResolverMaxPrAgeDays,
  isSuggesterRoutingMode,
  type SuggesterRoutingMode,
  type AnnouncerFrequency,
  type ManagerStatsFrequency,
  isScheduleOnlyBackgroundAutomationFrequency,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
  type SecurityAuditorFrequency,
  type SentryTriageFrequency,
  getTriggerableBackgroundAutomationDescriptor,
  isChannelAutoStartLaunchMode,
  isSharedManagerChannelOnlyKind,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
  AUTO_RESOLVE_CONFLICTS_LABEL,
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import {
  backgroundAgentSettings,
  backgroundAutomations,
  backgroundAutomationTargets,
} from '../schema';
import type {
  BackgroundAgentSettings,
  CodeQualityAuditorScanCursor,
  SecurityAuditorScanCursor,
} from '../types';

function getScheduledAutomationModes<TMode extends string>(
  agentId: Parameters<typeof getTriggerableBackgroundAutomationDescriptor>[0],
) {
  const descriptor = getTriggerableBackgroundAutomationDescriptor(agentId);

  if (!descriptor) {
    throw new Error(`Missing background automation descriptor for ${agentId}.`);
  }

  return [...descriptor.schedule.modes] as TMode[];
}

export const CONFLICT_RESOLVER_FREQUENCIES =
  getScheduledAutomationModes<ConflictResolverFrequency>('conflictResolver');

export const COACH_FREQUENCIES: CoachFrequency[] = [
  'off',
  'daily',
  'weekly',
  'biweekly',
];

export const ANNOUNCER_FREQUENCIES =
  getScheduledAutomationModes<AnnouncerFrequency>('announcer');

export const SUGGESTER_FREQUENCIES =
  getScheduledAutomationModes<SuggesterFrequency>('suggester');

export const MANAGER_STATS_FREQUENCIES =
  getScheduledAutomationModes<ManagerStatsFrequency>('managerStats');

export const SENTRY_TRIAGE_FREQUENCIES =
  getScheduledAutomationModes<SentryTriageFrequency>('sentryTriage');

export const DEPENDABOT_TRIAGE_FREQUENCIES =
  getScheduledAutomationModes<DependabotTriageFrequency>('dependabotTriage');

export const SECURITY_AUDITOR_FREQUENCIES =
  getScheduledAutomationModes<SecurityAuditorFrequency>('securityAuditor');

export const CODE_QUALITY_AUDITOR_FREQUENCIES =
  getScheduledAutomationModes<CodeQualityAuditorFrequency>(
    'codeQualityAuditor',
  );

export const DEFAULT_CONFLICT_RESOLVER_LABEL = AUTO_RESOLVE_CONFLICTS_LABEL;
export {
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
} from '@roomote/types';

const DEFAULT_CONFLICT_RESOLVER_FREQUENCY: ConflictResolverFrequency = 'off';
const DEFAULT_COACH_FREQUENCY: CoachFrequency = 'off';
const DEFAULT_SUGGESTER_FREQUENCY: SuggesterFrequency = 'off';
const DEFAULT_ANNOUNCER_FREQUENCY: AnnouncerFrequency = 'off';
const DEFAULT_MANAGER_STATS_FREQUENCY: ManagerStatsFrequency = 'off';
const DEFAULT_SENTRY_TRIAGE_FREQUENCY: SentryTriageFrequency = 'off';
const DEFAULT_DEPENDABOT_TRIAGE_FREQUENCY: DependabotTriageFrequency = 'off';
const SCHEDULE_ONLY_AUTOMATION_SCAN_CURSOR_SETTING_KEY = 'scanCursor';

export const MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS = {
  suggesterFrequency: 'daily',
  announcerFrequency: 'weekly',
  managerStatsFrequency: 'weekly',
} as const satisfies Pick<
  BackgroundAgentSettings,
  'suggesterFrequency' | 'announcerFrequency' | 'managerStatsFrequency'
>;

type ManagerChannelLegacyKind =
  | 'coach'
  | 'suggester'
  | 'announcer'
  | 'platformIssue';

const MANAGER_CHANNEL_LEGACY_KINDS: ManagerChannelLegacyKind[] = [
  'coach',
  'suggester',
  'announcer',
  'platformIssue',
];

function isLegacyManagerChannelKind(
  kind: ManagerChannelLegacyKind | BackgroundAutomationManagerChannelKind,
): kind is ManagerChannelLegacyKind {
  return (MANAGER_CHANNEL_LEGACY_KINDS as string[]).includes(kind);
}

type AutomationWithTargets = typeof backgroundAutomations.$inferSelect & {
  targets: Array<typeof backgroundAutomationTargets.$inferSelect>;
};

type ScheduleOnlyNormalizedFieldKey =
  | (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST)[number]['frequencyField']
  | (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST)[number]['lastRunAtField']
  | (typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST)[number]['scanCursorField'];

type ScheduleOnlyNormalizedFields = Pick<
  BackgroundAgentSettings,
  ScheduleOnlyNormalizedFieldKey
>;

export type BackgroundAutomationTargetInput = {
  provider: BackgroundAutomationProvider;
  targetKind: BackgroundAutomationTargetKind;
  externalRef: string;
  metadata?: Record<string, unknown>;
};

export type UpsertBackgroundAutomationInput = {
  automationKey: BackgroundAutomationKey;
  enabled: boolean;
  schedule?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  targets?: BackgroundAutomationTargetInput[];
  updatedAt?: Date;
};

export type SlackEmojiPreferences = Pick<
  BackgroundAgentSettings,
  'slackSummonEmoji' | 'slackAckEmoji' | 'slackCompletionEmoji'
>;

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isConflictResolverFrequency(
  value: string,
): value is ConflictResolverFrequency {
  return (CONFLICT_RESOLVER_FREQUENCIES as string[]).includes(value);
}

function isCoachFrequency(value: string): value is CoachFrequency {
  return (COACH_FREQUENCIES as string[]).includes(value);
}

function isSuggesterFrequency(value: string): value is SuggesterFrequency {
  return (SUGGESTER_FREQUENCIES as string[]).includes(value);
}

function getSuggesterRoutingMode(
  automation: AutomationWithTargets | undefined,
  fallbackMode: SuggesterRoutingMode,
): SuggesterRoutingMode {
  const routingMode = getAutomationSettingText(automation, 'routingMode');

  return routingMode && isSuggesterRoutingMode(routingMode)
    ? routingMode
    : fallbackMode;
}

function isAnnouncerFrequency(value: string): value is AnnouncerFrequency {
  return (ANNOUNCER_FREQUENCIES as string[]).includes(value);
}

function isManagerStatsFrequency(
  value: string,
): value is ManagerStatsFrequency {
  return (MANAGER_STATS_FREQUENCIES as string[]).includes(value);
}

function isSentryTriageFrequency(
  value: string,
): value is SentryTriageFrequency {
  return (SENTRY_TRIAGE_FREQUENCIES as string[]).includes(value);
}

function isDependabotTriageFrequency(
  value: string,
): value is DependabotTriageFrequency {
  return (DEPENDABOT_TRIAGE_FREQUENCIES as string[]).includes(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string'),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function getChannelAutoStartTargetOrder(
  target: typeof backgroundAutomationTargets.$inferSelect,
): number | null {
  return asNumber(target.metadata.order);
}

function getAutomationScheduleMode(
  automation: AutomationWithTargets | undefined,
): string | null {
  const schedule = asObject(automation?.schedule);
  return asString(schedule.mode);
}

function getAutomationSettingText(
  automation: AutomationWithTargets | undefined,
  key: string,
): string | null {
  const settings = asObject(automation?.settings);
  return asString(settings[key]);
}

function getAutomationSettingNumber(
  automation: AutomationWithTargets | undefined,
  key: string,
): number | null {
  const settings = asObject(automation?.settings);
  return asNumber(settings[key]);
}

function getAutomationSettingBoolean(
  automation: AutomationWithTargets | undefined,
  key: string,
): boolean | null {
  const settings = asObject(automation?.settings);
  return asBoolean(settings[key]);
}

function getAutomationSettingStringArray(
  automation: AutomationWithTargets | undefined,
  key: string,
): string[] {
  const settings = asObject(automation?.settings);
  return asStringArray(settings[key]);
}

export function normalizeReviewCodeAutomationSettings(
  automation: AutomationWithTargets | undefined,
): PrReviewerSettings {
  return {
    ...DEFAULT_PR_REVIEWER_SETTINGS,
    backgroundAgentManaged: true,
    enabled: automation?.enabled ?? DEFAULT_PR_REVIEWER_SETTINGS.enabled,
    environmentScope: 'all',
    environmentIds: [],
    authorReviewMode: 'specific',
    reviewAllPullRequestAuthors:
      getAutomationSettingBoolean(automation, 'reviewAllPullRequestAuthors') ??
      DEFAULT_PR_REVIEWER_SETTINGS.reviewAllPullRequestAuthors,
    reviewOnCommit:
      getAutomationSettingBoolean(automation, 'reviewOnCommit') ??
      DEFAULT_PR_REVIEWER_SETTINGS.reviewOnCommit,
    reviewDraftPrs:
      getAutomationSettingBoolean(automation, 'reviewDraftPrs') ??
      DEFAULT_PR_REVIEWER_SETTINGS.reviewDraftPrs,
    relayReviewResultsToTask:
      getAutomationSettingBoolean(automation, 'relayReviewResultsToTask') ??
      DEFAULT_PR_REVIEWER_SETTINGS.relayReviewResultsToTask,
    relayEligibleCreatorIds: getAutomationSettingStringArray(
      automation,
      'relayEligibleCreatorIds',
    ),
    approvePr:
      getAutomationSettingBoolean(automation, 'approvePr') ??
      DEFAULT_PR_REVIEWER_SETTINGS.approvePr,
  };
}

function getScheduleOnlyAutomationScanCursor(
  automation: AutomationWithTargets | undefined,
): SecurityAuditorScanCursor | null {
  const settings = asObject(automation?.settings);
  const cursor = asObject(
    settings[SCHEDULE_ONLY_AUTOMATION_SCAN_CURSOR_SETTING_KEY],
  );
  const mergedAt = asString(cursor.mergedAt);
  const externalPullRequestId = asNumber(cursor.externalPullRequestId);

  if (
    !mergedAt ||
    externalPullRequestId === null ||
    Number.isNaN(new Date(mergedAt).getTime())
  ) {
    return null;
  }

  return {
    mergedAt,
    externalPullRequestId,
  };
}

function buildScheduleOnlyLegacyDefaults(): ScheduleOnlyNormalizedFields {
  return Object.fromEntries(
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.flatMap((automation) => [
      [automation.frequencyField, automation.defaultFrequency],
      [automation.lastRunAtField, null],
      [automation.scanCursorField, null],
    ]),
  ) as ScheduleOnlyNormalizedFields;
}

function normalizeScheduleOnlyAutomationSettings(params: {
  legacy: BackgroundAgentSettings;
  automationMap: Map<BackgroundAutomationKey, AutomationWithTargets>;
}): ScheduleOnlyNormalizedFields {
  const normalized = {} as ScheduleOnlyNormalizedFields;

  for (const automation of SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST) {
    const currentAutomation = params.automationMap.get(
      automation.automationKey,
    );
    (normalized as Record<string, unknown>)[automation.frequencyField] =
      getAutomationFrequency(
        currentAutomation,
        params.legacy[automation.frequencyField],
        isScheduleOnlyBackgroundAutomationFrequency,
      );
    (normalized as Record<string, unknown>)[automation.lastRunAtField] =
      getMostRecentRunAt(
        currentAutomation,
        params.legacy[automation.lastRunAtField],
      );
    (normalized as Record<string, unknown>)[automation.scanCursorField] =
      getScheduleOnlyAutomationScanCursor(currentAutomation);
  }

  return normalized;
}

function getAutomationTarget(
  automation: AutomationWithTargets | undefined,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
): string | null {
  return (
    automation?.targets.find(
      (target) =>
        target.provider === provider && target.targetKind === targetKind,
    )?.externalRef ?? null
  );
}

function getAutomationTargets(
  automation: AutomationWithTargets | undefined,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
): string[] {
  return [
    ...new Set(
      (automation?.targets ?? [])
        .filter(
          (target) =>
            target.provider === provider && target.targetKind === targetKind,
        )
        .map((target) => target.externalRef)
        .filter(Boolean),
    ),
  ];
}

function getChannelAutoStartTargets(
  automation: AutomationWithTargets | undefined,
): BackgroundAgentSettings['channelAutoStartSlackChannels'] {
  const legacyInstructions = getAutomationSettingText(
    automation,
    'instructions',
  );
  const targets = (automation?.targets ?? []).filter(
    (target) =>
      target.provider === 'slack' && target.targetKind === 'slack_channel',
  );
  const orderedTargets = [...targets].sort((left, right) => {
    const leftOrder = getChannelAutoStartTargetOrder(left);
    const rightOrder = getChannelAutoStartTargetOrder(right);

    if (leftOrder !== null && rightOrder !== null) {
      return leftOrder - rightOrder;
    }

    if (leftOrder !== null) {
      return -1;
    }

    if (rightOrder !== null) {
      return 1;
    }

    return 0;
  });
  const shouldUseLegacyInstructionsFallback = targets.length === 1;

  return orderedTargets.map((target, index) => {
    const launchMode = asString(target.metadata.launchMode);

    return {
      channelId: target.externalRef,
      instructions:
        asString(target.metadata.instructions) ??
        (shouldUseLegacyInstructionsFallback && index === 0
          ? legacyInstructions
          : null),
      launchMode:
        launchMode && isChannelAutoStartLaunchMode(launchMode)
          ? launchMode
          : DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      launchCriteria: asString(target.metadata.launchCriteria),
    };
  });
}

function getAutomationSettingTextOrLegacy(
  automation: AutomationWithTargets | undefined,
  legacyValue: string | null,
  key: string,
): string | null {
  if (!automation) {
    return legacyValue;
  }

  return getAutomationSettingText(automation, key);
}

function getConflictResolverMaxPrAgeDays(
  automation: AutomationWithTargets | undefined,
  fallbackValue: ConflictResolverMaxPrAgeDays,
): ConflictResolverMaxPrAgeDays {
  const maxPrAgeDays = getAutomationSettingNumber(automation, 'maxPrAgeDays');

  return maxPrAgeDays !== null && isConflictResolverMaxPrAgeDays(maxPrAgeDays)
    ? maxPrAgeDays
    : fallbackValue;
}

function getAutomationTargetOrLegacy(
  automation: AutomationWithTargets | undefined,
  legacyValue: string | null,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
): string | null {
  if (!automation) {
    return legacyValue;
  }

  return getAutomationTarget(automation, provider, targetKind);
}

function getAutomationTargetOrManagerFallback(
  automation: AutomationWithTargets | undefined,
  legacyValue: string | null,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
  managerFallback: string | null,
): string | null {
  if (!automation) {
    return legacyValue ?? managerFallback;
  }

  return (
    getAutomationTarget(automation, provider, targetKind) ?? managerFallback
  );
}

function getAutomationTargetsTextOrLegacy(
  automation: AutomationWithTargets | undefined,
  legacyValue: string | null,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
): string | null {
  if (!automation) {
    return legacyValue;
  }

  const targets = getAutomationTargets(automation, provider, targetKind);
  return targets.length > 0 ? targets.join('\n') : null;
}

function getMostRecentRunAt(
  automation: AutomationWithTargets | undefined,
  legacyValue: Date | null,
): Date | null {
  if (!automation?.lastRunAt) {
    return legacyValue;
  }

  if (!legacyValue) {
    return automation.lastRunAt;
  }

  return automation.lastRunAt > legacyValue
    ? automation.lastRunAt
    : legacyValue;
}

function getAutomationFrequency<T extends string>(
  automation: AutomationWithTargets | undefined,
  fallback: T,
  validator: (value: string) => value is T,
): T {
  if (!automation) {
    return fallback;
  }

  if (!automation.enabled) {
    return 'off' as T;
  }

  const mode = getAutomationScheduleMode(automation);
  return mode && validator(mode) ? mode : ('off' as T);
}

function buildAutomationMap(
  automations: AutomationWithTargets[],
): Map<BackgroundAutomationKey, AutomationWithTargets> {
  return new Map(
    automations.map((automation) => [automation.automationKey, automation]),
  );
}

export function normalizeSlackReactionName(value: string | null | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return '';
  }

  const withoutBoundaryColons = trimmed.replace(/^:+|:+$/g, '');
  return withoutBoundaryColons.trim().toLowerCase().split('::')[0] ?? '';
}

export function normalizeOptionalSlackEmojiName(
  value: string | null | undefined,
) {
  const normalized = normalizeSlackReactionName(value);
  return normalized.length > 0 ? normalized : null;
}

export function resolveLegacyManagerSlackChannelId(
  row:
    | Partial<
        Pick<
          typeof backgroundAgentSettings.$inferSelect,
          | 'coachSlackChannelId'
          | 'suggesterSlackChannelId'
          | 'announcerSlackChannelId'
          | 'platformIssueSlackChannelId'
        >
      >
    | null
    | undefined,
  kind: ManagerChannelLegacyKind,
): string | null {
  switch (kind) {
    case 'coach':
      return row?.coachSlackChannelId ?? null;
    case 'suggester':
      return row?.suggesterSlackChannelId ?? null;
    case 'announcer':
      return row?.announcerSlackChannelId ?? null;
    case 'platformIssue':
      return row?.platformIssueSlackChannelId ?? null;
  }
}

export function inferSharedManagerSlackChannelId(
  row?: Partial<
    Pick<
      typeof backgroundAgentSettings.$inferSelect,
      | 'managerSlackChannelId'
      | 'coachSlackChannelId'
      | 'suggesterSlackChannelId'
      | 'announcerSlackChannelId'
      | 'platformIssueSlackChannelId'
    >
  > | null,
): string | null {
  if (row?.managerSlackChannelId) {
    return row.managerSlackChannelId;
  }

  const legacyChannelIds = MANAGER_CHANNEL_LEGACY_KINDS.map((kind) =>
    resolveLegacyManagerSlackChannelId(row, kind),
  ).filter((channelId): channelId is string => Boolean(channelId));

  if (legacyChannelIds.length === 0) {
    return null;
  }

  const uniqueLegacyChannels = [...new Set(legacyChannelIds)];
  return uniqueLegacyChannels.length === 1 ? uniqueLegacyChannels[0]! : null;
}

export function hasDivergedLegacyManagerSlackChannels(
  row?: Partial<
    Pick<
      typeof backgroundAgentSettings.$inferSelect,
      | 'coachSlackChannelId'
      | 'suggesterSlackChannelId'
      | 'announcerSlackChannelId'
      | 'platformIssueSlackChannelId'
    >
  > | null,
): boolean {
  const legacyChannelIds = MANAGER_CHANNEL_LEGACY_KINDS.map((kind) =>
    resolveLegacyManagerSlackChannelId(row, kind),
  ).filter((channelId): channelId is string => Boolean(channelId));

  return new Set(legacyChannelIds).size > 1;
}

export function resolveManagerSlackChannelId(
  row:
    | (Partial<
        Pick<
          typeof backgroundAgentSettings.$inferSelect,
          | 'managerSlackChannelId'
          | 'coachSlackChannelId'
          | 'suggesterSlackChannelId'
          | 'announcerSlackChannelId'
          | 'platformIssueSlackChannelId'
        >
      > & {
        managerStatsSlackChannelId?: string | null;
        sentryTriageSlackChannelId?: string | null;
        dependabotTriageSlackChannelId?: string | null;
        securityAuditorSlackChannelId?: string | null;
        codeQualityAuditorSlackChannelId?: string | null;
        ciFailureTriageSlackChannelId?: string | null;
      })
    | null
    | undefined,
  kind: ManagerChannelLegacyKind | BackgroundAutomationManagerChannelKind,
): string | null {
  switch (kind) {
    case 'managerStats':
      if (row?.managerStatsSlackChannelId) {
        return row.managerStatsSlackChannelId;
      }
      break;
    case 'sentryTriage':
      if (row?.sentryTriageSlackChannelId) {
        return row.sentryTriageSlackChannelId;
      }
      break;
    case 'dependabotTriage':
      if (row?.dependabotTriageSlackChannelId) {
        return row.dependabotTriageSlackChannelId;
      }
      break;
    case 'securityAuditor':
      if (row?.securityAuditorSlackChannelId) {
        return row.securityAuditorSlackChannelId;
      }
      break;
    case 'codeQualityAuditor':
      if (row?.codeQualityAuditorSlackChannelId) {
        return row.codeQualityAuditorSlackChannelId;
      }
      break;
    case 'ciFailureTriage':
      if (row?.ciFailureTriageSlackChannelId) {
        return row.ciFailureTriageSlackChannelId;
      }
      break;
  }

  const sharedChannelId = inferSharedManagerSlackChannelId(row);

  if (sharedChannelId) {
    return sharedChannelId;
  }

  if (
    typeof kind === 'string' &&
    isSharedManagerChannelOnlyKind(
      kind as BackgroundAutomationManagerChannelKind,
    )
  ) {
    return null;
  }

  return isLegacyManagerChannelKind(kind)
    ? resolveLegacyManagerSlackChannelId(row, kind)
    : null;
}

function normalizeLegacyBackgroundAgentSettings(
  row?: typeof backgroundAgentSettings.$inferSelect | null,
): BackgroundAgentSettings {
  const now = new Date();
  const managerSlackChannelId = inferSharedManagerSlackChannelId(row);

  return {
    id: row?.id ?? 'default',
    globalAgentInstructions: row?.globalAgentInstructions ?? null,
    authorshipInstructions: row?.authorshipInstructions ?? null,
    compiledAuthorshipRules: row?.compiledAuthorshipRules ?? [],
    compiledAuthorshipIssues: row?.compiledAuthorshipIssues ?? [],
    compiledAuthorshipAt: row?.compiledAuthorshipAt ?? null,
    styleGuidance: normalizeOptionalText(row?.styleGuidance),
    suggesterInstructions: row?.suggesterInstructions ?? null,
    suggesterRoutingMode: DEFAULT_SUGGESTER_ROUTING_MODE,
    suggesterRoutingInstructions: null,
    suggesterFrequency:
      row?.suggesterFrequency && isSuggesterFrequency(row.suggesterFrequency)
        ? row.suggesterFrequency
        : DEFAULT_SUGGESTER_FREQUENCY,
    suggesterSlackChannelId: row?.suggesterSlackChannelId ?? null,
    suggesterLastRunAt: row?.suggesterLastRunAt ?? null,
    conflictResolverFrequency:
      row?.conflictResolverFrequency &&
      isConflictResolverFrequency(row.conflictResolverFrequency)
        ? row.conflictResolverFrequency
        : DEFAULT_CONFLICT_RESOLVER_FREQUENCY,
    conflictResolverLabel:
      row?.conflictResolverLabel?.trim() || DEFAULT_CONFLICT_RESOLVER_LABEL,
    conflictResolverInstructions: row?.conflictResolverInstructions ?? null,
    conflictResolverMaxPrAgeDays: DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
    conflictResolverLastRunAt: row?.conflictResolverLastRunAt ?? null,
    channelAutoStartSlackChannels: [],
    channelAutoStartEnabled: false,
    channelAutoStartSlackChannelIds: [],
    channelAutoStartInstructions: null,
    reviewCodeSettings: normalizeReviewCodeAutomationSettings(undefined),
    coachFrequency:
      row?.coachFrequency && isCoachFrequency(row.coachFrequency)
        ? row.coachFrequency
        : DEFAULT_COACH_FREQUENCY,
    coachSlackChannelId: row?.coachSlackChannelId ?? null,
    coachInstructions: row?.coachInstructions ?? null,
    coachLastRunAt: row?.coachLastRunAt ?? null,
    announcerFrequency:
      row?.announcerFrequency && isAnnouncerFrequency(row.announcerFrequency)
        ? row.announcerFrequency
        : DEFAULT_ANNOUNCER_FREQUENCY,
    announcerSlackChannelId: row?.announcerSlackChannelId ?? null,
    platformIssueSlackChannelId: row?.platformIssueSlackChannelId ?? null,
    managerSlackChannelId,
    managerStatsFrequency:
      row?.managerStatsFrequency &&
      isManagerStatsFrequency(row.managerStatsFrequency)
        ? row.managerStatsFrequency
        : DEFAULT_MANAGER_STATS_FREQUENCY,
    managerStatsLastRunAt: row?.managerStatsLastRunAt ?? null,
    sentryTriageFrequency: DEFAULT_SENTRY_TRIAGE_FREQUENCY,
    sentryTriageProjectSlugs: null,
    sentryTriageLastRunAt: null,
    dependabotTriageFrequency: DEFAULT_DEPENDABOT_TRIAGE_FREQUENCY,
    dependabotTriageLastRunAt: null,
    ...buildScheduleOnlyLegacyDefaults(),
    announcerInstructions: row?.announcerInstructions ?? null,
    announcerLastRunAt: row?.announcerLastRunAt ?? null,
    managerStatsSlackChannelId: managerSlackChannelId,
    slackSummonEmoji: normalizeOptionalSlackEmojiName(row?.slackSummonEmoji),
    slackAckEmoji:
      normalizeOptionalSlackEmojiName(row?.slackAckEmoji) ??
      DEFAULT_SLACK_ACK_EMOJI,
    slackCompletionEmoji:
      normalizeOptionalSlackEmojiName(row?.slackCompletionEmoji) ??
      DEFAULT_SLACK_COMPLETION_EMOJI,
    sentryTriageSlackChannelId: managerSlackChannelId,
    dependabotTriageSlackChannelId: managerSlackChannelId,
    securityAuditorSlackChannelId: managerSlackChannelId,
    codeQualityAuditorSlackChannelId: managerSlackChannelId,
    ciFailureTriageSlackChannelId: managerSlackChannelId,
    createdAt: row?.createdAt ?? now,
    updatedAt: row?.updatedAt ?? now,
  };
}

export function normalizeBackgroundAgentSettings(
  row?: typeof backgroundAgentSettings.$inferSelect | null,
  automations: AutomationWithTargets[] = [],
): BackgroundAgentSettings {
  const legacy = normalizeLegacyBackgroundAgentSettings(row);
  const automationMap = buildAutomationMap(automations);

  const reviewCodeAutomation = automationMap.get('review_code');
  const conflictResolverAutomation = automationMap.get('conflict_resolver');
  const coachAutomation = automationMap.get('coach');
  const suggesterAutomation = automationMap.get('suggester');
  const announcerAutomation = automationMap.get('announcer');
  const channelAutoStartAutomation = automationMap.get(
    'slack_channel_auto_start',
  );
  const channelAutoStartTargets = getChannelAutoStartTargets(
    channelAutoStartAutomation,
  );
  const managerStatsAutomation = automationMap.get('manager_stats');
  const platformIssueAutomation = automationMap.get('platform_issue_alerts');
  const sentryTriageAutomation = automationMap.get('sentry_triage');
  const dependabotTriageAutomation = automationMap.get('dependabot_triage');
  const securityAuditorAutomation = automationMap.get('security_auditor');
  const codeQualityAuditorAutomation = automationMap.get(
    'code_quality_auditor',
  );
  const ciFailureTriageAutomation = automationMap.get('ci_failure_triage');
  const sharedManagerSlackChannelId = legacy.managerSlackChannelId;

  return {
    ...legacy,
    ...normalizeScheduleOnlyAutomationSettings({
      legacy,
      automationMap,
    }),
    channelAutoStartSlackChannels: channelAutoStartTargets,
    channelAutoStartEnabled:
      channelAutoStartAutomation?.enabled === true &&
      channelAutoStartTargets.length > 0,
    channelAutoStartInstructions:
      channelAutoStartTargets[0]?.instructions ?? null,
    channelAutoStartSlackChannelIds: channelAutoStartTargets.map(
      ({ channelId }) => channelId,
    ),
    reviewCodeSettings:
      normalizeReviewCodeAutomationSettings(reviewCodeAutomation),
    conflictResolverFrequency: getAutomationFrequency(
      conflictResolverAutomation,
      legacy.conflictResolverFrequency,
      isConflictResolverFrequency,
    ),
    conflictResolverLabel: conflictResolverAutomation
      ? (getAutomationSettingText(conflictResolverAutomation, 'label') ??
        DEFAULT_CONFLICT_RESOLVER_LABEL)
      : legacy.conflictResolverLabel,
    conflictResolverInstructions: getAutomationSettingTextOrLegacy(
      conflictResolverAutomation,
      legacy.conflictResolverInstructions,
      'instructions',
    ),
    conflictResolverMaxPrAgeDays: getConflictResolverMaxPrAgeDays(
      conflictResolverAutomation,
      legacy.conflictResolverMaxPrAgeDays,
    ),
    conflictResolverLastRunAt: getMostRecentRunAt(
      conflictResolverAutomation,
      legacy.conflictResolverLastRunAt,
    ),
    coachFrequency: getAutomationFrequency(
      coachAutomation,
      legacy.coachFrequency,
      isCoachFrequency,
    ),
    coachSlackChannelId: getAutomationTargetOrLegacy(
      coachAutomation,
      legacy.coachSlackChannelId,
      'slack',
      'slack_channel',
    ),
    coachInstructions: getAutomationSettingTextOrLegacy(
      coachAutomation,
      legacy.coachInstructions,
      'instructions',
    ),
    coachLastRunAt: getMostRecentRunAt(coachAutomation, legacy.coachLastRunAt),
    suggesterFrequency: getAutomationFrequency(
      suggesterAutomation,
      legacy.suggesterFrequency,
      isSuggesterFrequency,
    ),
    suggesterSlackChannelId: getAutomationTargetOrLegacy(
      suggesterAutomation,
      legacy.suggesterSlackChannelId,
      'slack',
      'slack_channel',
    ),
    suggesterInstructions: getAutomationSettingTextOrLegacy(
      suggesterAutomation,
      legacy.suggesterInstructions,
      'instructions',
    ),
    suggesterRoutingMode: getSuggesterRoutingMode(
      suggesterAutomation,
      legacy.suggesterRoutingMode,
    ),
    suggesterRoutingInstructions: getAutomationSettingTextOrLegacy(
      suggesterAutomation,
      legacy.suggesterRoutingInstructions,
      'routingInstructions',
    ),
    suggesterLastRunAt: getMostRecentRunAt(
      suggesterAutomation,
      legacy.suggesterLastRunAt,
    ),
    announcerFrequency: getAutomationFrequency(
      announcerAutomation,
      legacy.announcerFrequency,
      isAnnouncerFrequency,
    ),
    announcerSlackChannelId: getAutomationTargetOrLegacy(
      announcerAutomation,
      legacy.announcerSlackChannelId,
      'slack',
      'slack_channel',
    ),
    announcerInstructions: getAutomationSettingTextOrLegacy(
      announcerAutomation,
      legacy.announcerInstructions,
      'instructions',
    ),
    announcerLastRunAt: getMostRecentRunAt(
      announcerAutomation,
      legacy.announcerLastRunAt,
    ),
    platformIssueSlackChannelId: getAutomationTargetOrLegacy(
      platformIssueAutomation,
      legacy.platformIssueSlackChannelId,
      'slack',
      'slack_channel',
    ),
    managerStatsSlackChannelId: getAutomationTargetOrManagerFallback(
      managerStatsAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
    managerStatsFrequency: getAutomationFrequency(
      managerStatsAutomation,
      legacy.managerStatsFrequency,
      isManagerStatsFrequency,
    ),
    managerStatsLastRunAt: getMostRecentRunAt(
      managerStatsAutomation,
      legacy.managerStatsLastRunAt,
    ),
    sentryTriageFrequency: getAutomationFrequency(
      sentryTriageAutomation,
      legacy.sentryTriageFrequency,
      isSentryTriageFrequency,
    ),
    sentryTriageSlackChannelId: getAutomationTargetOrManagerFallback(
      sentryTriageAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
    sentryTriageProjectSlugs: getAutomationTargetsTextOrLegacy(
      sentryTriageAutomation,
      legacy.sentryTriageProjectSlugs,
      'sentry',
      'sentry_project',
    ),
    sentryTriageLastRunAt: getMostRecentRunAt(
      sentryTriageAutomation,
      legacy.sentryTriageLastRunAt,
    ),
    dependabotTriageFrequency: getAutomationFrequency(
      dependabotTriageAutomation,
      legacy.dependabotTriageFrequency,
      isDependabotTriageFrequency,
    ),
    dependabotTriageSlackChannelId: getAutomationTargetOrManagerFallback(
      dependabotTriageAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
    dependabotTriageLastRunAt: getMostRecentRunAt(
      dependabotTriageAutomation,
      legacy.dependabotTriageLastRunAt,
    ),
    securityAuditorSlackChannelId: getAutomationTargetOrManagerFallback(
      securityAuditorAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
    codeQualityAuditorSlackChannelId: getAutomationTargetOrManagerFallback(
      codeQualityAuditorAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
    ciFailureTriageSlackChannelId: getAutomationTargetOrManagerFallback(
      ciFailureTriageAutomation,
      null,
      'slack',
      'slack_channel',
      sharedManagerSlackChannelId,
    ),
  };
}

export async function ensureBackgroundAgentSettingsRow(): Promise<void> {
  await db.insert(backgroundAgentSettings).values({}).onConflictDoNothing({
    target: backgroundAgentSettings.id,
  });
}

export async function listBackgroundAutomations(): Promise<
  AutomationWithTargets[]
> {
  return db.query.backgroundAutomations.findMany({
    with: {
      targets: true,
    },
  });
}

export async function upsertBackgroundAutomation(
  tx: DatabaseOrTransaction,
  input: UpsertBackgroundAutomationInput,
): Promise<void> {
  const now = input.updatedAt ?? new Date();
  const schedule = input.enabled ? (input.schedule ?? {}) : {};
  const values: typeof backgroundAutomations.$inferInsert = {
    automationKey: input.automationKey,
    enabled: input.enabled,
    schedule,
    updatedAt: now,
  };
  const set: Partial<typeof backgroundAutomations.$inferInsert> = {
    enabled: input.enabled,
    schedule,
    updatedAt: now,
  };

  if (input.settings !== undefined) {
    values.settings = input.settings;
    set.settings = input.settings;
  }

  const [automation] = await tx
    .insert(backgroundAutomations)
    .values(values)
    .onConflictDoUpdate({
      target: [backgroundAutomations.automationKey],
      set,
    })
    .returning({
      id: backgroundAutomations.id,
    });

  if (!automation) {
    throw new Error(
      `Failed to upsert background automation ${input.automationKey}.`,
    );
  }

  await tx
    .delete(backgroundAutomationTargets)
    .where(eq(backgroundAutomationTargets.automationId, automation.id));

  if (!input.targets || input.targets.length === 0) {
    return;
  }

  await tx.insert(backgroundAutomationTargets).values(
    input.targets.map((target) => ({
      automationId: automation.id,
      provider: target.provider,
      targetKind: target.targetKind,
      externalRef: target.externalRef,
      metadata: target.metadata ?? {},
      updatedAt: now,
    })),
  );
}

export async function recordBackgroundAutomationRun(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: BackgroundAutomationKey;
    runAt: Date;
  },
): Promise<void> {
  await tx
    .update(backgroundAutomations)
    .set({
      lastRunAt: params.runAt,
      updatedAt: params.runAt,
    })
    .where(eq(backgroundAutomations.automationKey, params.automationKey));
}

async function updateScheduleOnlyAutomationScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: 'security_auditor' | 'code_quality_auditor';
    cursor: SecurityAuditorScanCursor | null;
    updatedAt?: Date;
  },
) {
  const [automation] = await tx
    .select({
      settings: backgroundAutomations.settings,
    })
    .from(backgroundAutomations)
    .where(eq(backgroundAutomations.automationKey, params.automationKey))
    .limit(1);

  if (!automation) {
    return null;
  }

  const settings = {
    ...asObject(automation.settings),
  };

  if (params.cursor) {
    settings[SCHEDULE_ONLY_AUTOMATION_SCAN_CURSOR_SETTING_KEY] = params.cursor;
  } else {
    delete settings[SCHEDULE_ONLY_AUTOMATION_SCAN_CURSOR_SETTING_KEY];
  }

  const [updated] = await tx
    .update(backgroundAutomations)
    .set({
      settings,
      updatedAt: params.updatedAt ?? new Date(),
    })
    .where(eq(backgroundAutomations.automationKey, params.automationKey))
    .returning({
      id: backgroundAutomations.id,
    });

  return updated ?? null;
}

export async function updateSecurityAuditorScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    cursor: SecurityAuditorScanCursor | null;
    updatedAt?: Date;
  },
) {
  return updateScheduleOnlyAutomationScanCursor(tx, {
    ...params,
    automationKey: 'security_auditor',
  });
}

export async function updateCodeQualityAuditorScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    cursor: CodeQualityAuditorScanCursor | null;
    updatedAt?: Date;
  },
) {
  return updateScheduleOnlyAutomationScanCursor(tx, {
    ...params,
    automationKey: 'code_quality_auditor',
  });
}

export function getBackgroundAutomationKeys(): BackgroundAutomationKey[] {
  return [...BACKGROUND_AUTOMATION_KEYS];
}

export async function getBackgroundAgentSettings(): Promise<BackgroundAgentSettings> {
  const [row, automations] = await Promise.all([
    db.query.backgroundAgentSettings.findFirst(),
    listBackgroundAutomations(),
  ]);

  return normalizeBackgroundAgentSettings(row, automations);
}

export async function getBackgroundAgentSettingsForDeployment(): Promise<BackgroundAgentSettings> {
  await ensureBackgroundAgentSettingsRow();

  const [row, automations] = await Promise.all([
    db.query.backgroundAgentSettings.findFirst(),
    listBackgroundAutomations(),
  ]);

  return normalizeBackgroundAgentSettings(row, automations);
}

export async function getReviewCodeAutomationSettings(): Promise<PrReviewerSettings> {
  const automation = await db.query.backgroundAutomations.findFirst({
    where: eq(backgroundAutomations.automationKey, 'review_code'),
    with: {
      targets: true,
    },
  });

  return normalizeReviewCodeAutomationSettings(automation);
}

export async function getSlackEmojiPreferencesForDeployment(): Promise<SlackEmojiPreferences> {
  const settings = await getBackgroundAgentSettingsForDeployment();

  return {
    slackSummonEmoji: settings.slackSummonEmoji,
    slackAckEmoji: settings.slackAckEmoji,
    slackCompletionEmoji: settings.slackCompletionEmoji,
  };
}

import { eq } from 'drizzle-orm';

import {
  type AnnouncerFrequency,
  type AutomationScanCursor,
  type AutomationTarget,
  type BackgroundAutomationKey,
  type BackgroundAutomationProvider,
  type BackgroundAutomationTargetKind,
  type CodeQualityAuditorFrequency,
  type CodeqlTriageFrequency,
  type ConflictResolverFrequency,
  type IssueFixerFrequency,
  type ConflictResolverMaxPrAgeDays,
  type DependabotTriageFrequency,
  type ManagerStatsFrequency,
  type PrReviewSettings,
  type SecurityAuditorFrequency,
  type SentryTriageFrequency,
  type SuggesterFrequency,
  type SuggesterRoutingMode,
  AUTOMATION_DESTINATION_DESCRIPTORS,
  AUTO_RESOLVE_CONFLICTS_LABEL,
  BACKGROUND_AUTOMATION_KEYS,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  DEFAULT_PR_REVIEW_SETTINGS,
  DEFAULT_SUGGESTER_ROUTING_MODE,
  getTriggerableBackgroundAutomationDescriptorByKey,
  isChannelAutoStartLaunchMode,
  isConflictResolverMaxPrAgeDays,
  isInternalAutomationKey,
  isSuggesterRoutingMode,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { automations, deploymentSettings } from '../schema';
import type {
  Automation,
  BackgroundAgentSettings,
  CodeQualityAuditorScanCursor,
  SecurityAuditorScanCursor,
} from '../types';

function getScheduleModes<TMode extends string>(
  automationKey: TriggerableBackgroundAutomationKey,
): TMode[] {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    throw new Error(
      `Missing background automation descriptor for ${automationKey}.`,
    );
  }

  return [...descriptor.scheduleModes] as TMode[];
}

export const CONFLICT_RESOLVER_FREQUENCIES =
  getScheduleModes<ConflictResolverFrequency>('conflict_resolver');

export const ANNOUNCER_FREQUENCIES =
  getScheduleModes<AnnouncerFrequency>('announcer');

export const SUGGESTER_FREQUENCIES =
  getScheduleModes<SuggesterFrequency>('suggester');

export const MANAGER_STATS_FREQUENCIES =
  getScheduleModes<ManagerStatsFrequency>('manager_stats');

export const SENTRY_TRIAGE_FREQUENCIES =
  getScheduleModes<SentryTriageFrequency>('sentry_triage');

export const DEPENDABOT_TRIAGE_FREQUENCIES =
  getScheduleModes<DependabotTriageFrequency>('dependabot_triage');

export const CODEQL_TRIAGE_FREQUENCIES =
  getScheduleModes<CodeqlTriageFrequency>('codeql_triage');

export const ISSUE_FIXER_FREQUENCIES =
  getScheduleModes<IssueFixerFrequency>('issue_fixer');

export const SECURITY_AUDITOR_FREQUENCIES =
  getScheduleModes<SecurityAuditorFrequency>('security_auditor');

export const CODE_QUALITY_AUDITOR_FREQUENCIES =
  getScheduleModes<CodeQualityAuditorFrequency>('code_quality_auditor');

export const DEFAULT_CONFLICT_RESOLVER_LABEL = AUTO_RESOLVE_CONFLICTS_LABEL;
export const MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS = {
  suggesterFrequency: 'daily',
  announcerFrequency: 'weekly',
  managerStatsFrequency: 'weekly',
} as const satisfies Pick<
  BackgroundAgentSettings,
  'suggesterFrequency' | 'announcerFrequency' | 'managerStatsFrequency'
>;

function isConflictResolverFrequency(
  value: string,
): value is ConflictResolverFrequency {
  return (CONFLICT_RESOLVER_FREQUENCIES as string[]).includes(value);
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

function getAutomationSettingText(
  automation: Automation | undefined,
  key: string,
): string | null {
  return asString(asObject(automation?.settings)[key]);
}

function getAutomationSettingNumber(
  automation: Automation | undefined,
  key: string,
): number | null {
  return asNumber(asObject(automation?.settings)[key]);
}

function getAutomationSettingBoolean(
  automation: Automation | undefined,
  key: string,
): boolean | null {
  return asBoolean(asObject(automation?.settings)[key]);
}

function getAutomationSettingStringArray(
  automation: Automation | undefined,
  key: string,
): string[] {
  return asStringArray(asObject(automation?.settings)[key]);
}

function getScheduleMode(automation: Automation | undefined): string | null {
  return asString(asObject(automation?.schedule).mode);
}

/**
 * Effective frequency for an automation: 'off' unless the automation is
 * enabled and its schedule mode is one of the automation's valid modes.
 */
function getAutomationFrequency<T extends string>(
  automation: Automation | undefined,
  validator: (value: string) => value is T,
): T {
  if (!automation?.enabled) {
    return 'off' as T;
  }

  const mode = getScheduleMode(automation);
  return mode && validator(mode) ? mode : ('off' as T);
}

export function getAutomationTargetRefs(
  automation: Pick<Automation, 'targets'> | undefined,
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

export function getAutomationSlackChannelTarget(
  automation: Pick<Automation, 'targets'> | undefined,
): string | null {
  return (
    getAutomationTargetRefs(automation, 'slack', 'slack_channel')[0] ?? null
  );
}

export function getAutomationDiscordChannelTarget(
  automation: Pick<Automation, 'targets'> | undefined,
): string | null {
  return (
    getAutomationTargetRefs(automation, 'discord', 'discord_channel')[0] ?? null
  );
}

export function getAutomationTelegramChatTarget(
  automation: Pick<Automation, 'targets'> | undefined,
): string | null {
  return (
    getAutomationTargetRefs(automation, 'telegram', 'telegram_chat')[0] ?? null
  );
}

/** Sticky Telegram forum-topic id owned by a telegram_chat target, if any. */
export function getAutomationTelegramTopicThreadId(
  automation: Pick<Automation, 'targets'> | undefined,
): string | null {
  const target = (automation?.targets ?? []).find(
    (entry) =>
      entry.provider === 'telegram' && entry.targetKind === 'telegram_chat',
  );
  if (!target) {
    return null;
  }
  const threadId = asString(asObject(target.metadata).threadId);
  return threadId?.trim() || null;
}

/**
 * Persist (or replace) the sticky Telegram forum topic id on the automation's
 * telegram_chat target. Creates the target when missing so first-run topic
 * creation can survive a save-with-openai race.
 */
export async function persistAutomationTelegramTopicThread(params: {
  automationKey: BackgroundAutomationKey;
  chatId: string;
  threadId: string;
  topicName?: string;
}): Promise<void> {
  const chatId = params.chatId.trim();
  const threadId = params.threadId.trim();
  if (!chatId || !threadId) {
    return;
  }

  const existing = await db.query.automations.findFirst({
    columns: { targets: true },
    where: eq(automations.key, params.automationKey),
  });
  const targets = [...(existing?.targets ?? [])];
  const index = targets.findIndex(
    (target) =>
      target.provider === 'telegram' && target.targetKind === 'telegram_chat',
  );
  const topicName = params.topicName?.trim();
  const nextMetadata = {
    ...(index >= 0 ? asObject(targets[index]?.metadata) : {}),
    threadId,
    ...(topicName ? { topicName } : {}),
  };
  const nextTarget: AutomationTarget = {
    provider: 'telegram',
    targetKind: 'telegram_chat',
    externalRef: chatId,
    metadata: nextMetadata,
  };

  if (index >= 0) {
    targets[index] = nextTarget;
  } else {
    targets.push(nextTarget);
  }

  await db
    .update(automations)
    .set({ targets, updatedAt: new Date() })
    .where(eq(automations.key, params.automationKey));
}

/**
 * Two-level Slack channel resolution: the automation's own slack_channel
 * target wins, otherwise the deployment-wide manager channel.
 */
export function resolveAutomationSlackChannelId(
  automation: Pick<Automation, 'targets'> | undefined,
  managerSlackChannelId: string | null,
): string | null {
  return getAutomationSlackChannelTarget(automation) ?? managerSlackChannelId;
}

/** Provider-neutral resolved destination an automation reports to. */
export type AutomationDestination = {
  provider: 'slack' | 'teams' | 'telegram' | 'discord';
  channelId: string;
  /** Which waterfall level produced this destination. */
  source: 'automation_target' | 'manager_channel';
};

const DESTINATION_TARGET_KINDS = [
  ['slack', 'slack_channel'],
  ['teams', 'teams_channel'],
  ['telegram', 'telegram_chat'],
  ['discord', 'discord_channel'],
] as const;

/**
 * Provider-neutral destination waterfall: the automation's own channel
 * target wins (Slack first when several providers are targeted), otherwise
 * the deployment-wide Slack manager channel. The primary-conversation
 * fallbacks for Teams/Telegram deployments without any Slack live in the
 * sdk runner layer, which owns those surfaces' installation lookups.
 */
export function resolveAutomationDestination(
  automation: Pick<Automation, 'targets'> | undefined,
  managerSlackChannelId: string | null,
): AutomationDestination | null {
  for (const [provider, targetKind] of DESTINATION_TARGET_KINDS) {
    const channelId = getAutomationTargetRefs(
      automation,
      provider,
      targetKind,
    )[0];

    if (channelId) {
      return { provider, channelId, source: 'automation_target' };
    }
  }

  return managerSlackChannelId
    ? {
        provider: 'slack',
        channelId: managerSlackChannelId,
        source: 'manager_channel',
      }
    : null;
}

function getChannelAutoStartTargets(
  automation: Automation | undefined,
  provider: BackgroundAutomationProvider,
  targetKind: BackgroundAutomationTargetKind,
): BackgroundAgentSettings['channelAutoStartSlackChannels'] {
  const targets = (automation?.targets ?? []).filter(
    (target) =>
      target.provider === provider && target.targetKind === targetKind,
  );
  const orderedTargets = [...targets].sort((left, right) => {
    const leftOrder = asNumber(asObject(left.metadata).order);
    const rightOrder = asNumber(asObject(right.metadata).order);

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

  return orderedTargets.map((target) => {
    const metadata = asObject(target.metadata);
    const launchMode = asString(metadata.launchMode);

    return {
      channelId: target.externalRef,
      instructions: asString(metadata.instructions),
      launchMode:
        launchMode && isChannelAutoStartLaunchMode(launchMode)
          ? launchMode
          : DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      launchCriteria: asString(metadata.launchCriteria),
    };
  });
}

export function normalizeReviewCodeAutomationSettings(
  automation: Automation | undefined,
): PrReviewSettings {
  return {
    ...DEFAULT_PR_REVIEW_SETTINGS,
    backgroundAgentManaged: true,
    enabled: automation?.enabled ?? DEFAULT_PR_REVIEW_SETTINGS.enabled,
    environmentScope: 'all',
    environmentIds: [],
    authorReviewMode: 'specific',
    reviewAllPullRequestAuthors:
      getAutomationSettingBoolean(automation, 'reviewAllPullRequestAuthors') ??
      DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors,
    reviewOnCommit:
      getAutomationSettingBoolean(automation, 'reviewOnCommit') ??
      DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit,
    reviewDraftPrs:
      getAutomationSettingBoolean(automation, 'reviewDraftPrs') ??
      DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs,
    relayReviewResultsToTask:
      getAutomationSettingBoolean(automation, 'relayReviewResultsToTask') ??
      DEFAULT_PR_REVIEW_SETTINGS.relayReviewResultsToTask,
    relayEligibleCreatorIds: getAutomationSettingStringArray(
      automation,
      'relayEligibleCreatorIds',
    ),
    approvePr:
      getAutomationSettingBoolean(automation, 'approvePr') ??
      DEFAULT_PR_REVIEW_SETTINGS.approvePr,
  };
}

/**
 * Idempotently seed one automations row per known key so
 * tasks.initiator_automation FK inserts always succeed. Existing rows are
 * never modified (except the internal flag, which is definitional).
 */
export async function ensureAutomationRows(
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client
    .insert(automations)
    .values(
      BACKGROUND_AUTOMATION_KEYS.map((key) => ({
        key,
        internal: isInternalAutomationKey(key),
      })),
    )
    .onConflictDoNothing({ target: automations.key });
}

let ensureAutomationRowsPromise: Promise<void> | null = null;

/**
 * Process-memoized ensureAutomationRows for hot paths (automation task
 * enqueues). Resets on failure so a transient DB error does not poison the
 * process.
 */
export function ensureAutomationRowsOnce(): Promise<void> {
  if (!ensureAutomationRowsPromise) {
    ensureAutomationRowsPromise = ensureAutomationRows().catch((error) => {
      ensureAutomationRowsPromise = null;
      throw error;
    });
  }

  return ensureAutomationRowsPromise;
}

export async function listAutomations(): Promise<Automation[]> {
  await ensureAutomationRows();
  return db.query.automations.findMany();
}

export async function getAutomationByKey(
  key: BackgroundAutomationKey,
): Promise<Automation | null> {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.key, key),
  });

  return automation ?? null;
}

export type UpsertAutomationInput = {
  key: BackgroundAutomationKey;
  enabled: boolean;
  schedule?: Record<string, unknown>;
  instructions?: string | null;
  settings?: Record<string, unknown>;
  targets?: AutomationTarget[];
  /**
   * Target kinds this write fully owns. When set alongside `targets`,
   * existing targets of OTHER kinds are preserved instead of being replaced
   * wholesale — so a Slack-only settings save cannot clobber teams/telegram
   * targets configured elsewhere. Omit to keep full-replacement semantics.
   */
  managedTargetKinds?: readonly BackgroundAutomationTargetKind[];
  updatedAt?: Date;
};

export async function upsertAutomation(
  tx: DatabaseOrTransaction,
  input: UpsertAutomationInput,
): Promise<void> {
  const now = input.updatedAt ?? new Date();
  const schedule = input.enabled ? (input.schedule ?? {}) : {};

  let targets = input.targets;
  if (input.targets !== undefined && input.managedTargetKinds !== undefined) {
    const managedKinds = new Set(input.managedTargetKinds);
    const existing = await tx.query.automations.findFirst({
      columns: { targets: true },
      where: eq(automations.key, input.key),
    });
    const existingTargets = existing?.targets ?? [];
    const preserved = existingTargets.filter(
      (target) => !managedKinds.has(target.targetKind),
    );
    // Merge sticky Telegram topic metadata when a write omits threadId but the
    // DB already has one for the same chat. Concurrent first-delivery topic
    // persistence must outlive an overlapping settings save.
    const nextManaged = input.targets.map((target) => {
      if (
        target.provider !== 'telegram' ||
        target.targetKind !== 'telegram_chat'
      ) {
        return target;
      }

      const incomingThreadId = asString(asObject(target.metadata).threadId);
      if (incomingThreadId?.trim()) {
        return target;
      }

      const prior = existingTargets.find(
        (entry) =>
          entry.provider === 'telegram' &&
          entry.targetKind === 'telegram_chat' &&
          entry.externalRef === target.externalRef,
      );
      const priorThreadId = asString(
        asObject(prior?.metadata).threadId,
      )?.trim();
      if (!prior || !priorThreadId) {
        return target;
      }

      return {
        ...target,
        metadata: {
          ...asObject(prior.metadata),
          ...asObject(target.metadata),
          threadId: priorThreadId,
        },
      };
    });
    targets = [...preserved, ...nextManaged];
  }

  const values: typeof automations.$inferInsert = {
    key: input.key,
    internal: isInternalAutomationKey(input.key),
    enabled: input.enabled,
    schedule,
    updatedAt: now,
  };
  const set: Partial<typeof automations.$inferInsert> = {
    enabled: input.enabled,
    schedule,
    updatedAt: now,
  };

  if (input.settings !== undefined) {
    values.settings = input.settings;
    set.settings = input.settings;
  }

  if (input.instructions !== undefined) {
    values.instructions = input.instructions;
    set.instructions = input.instructions;
  }

  if (targets !== undefined) {
    values.targets = targets;
    set.targets = targets;
  }

  await tx.insert(automations).values(values).onConflictDoUpdate({
    target: automations.key,
    set,
  });
}

export type AutomationRunOutcomeStatus = 'succeeded' | 'failed' | 'skipped';

/**
 * Record the terminal outcome of an automation pass on the automations row.
 * Succeeded/skipped clear lastError; failed stamps lastFailedAt/lastError.
 * lastRunAt advances to the pass timestamp unless 'skip' is passed (used by
 * cursor-driven scans that manage their own scan window).
 */
export async function recordAutomationRunOutcome(
  tx: DatabaseOrTransaction,
  params: {
    key: BackgroundAutomationKey;
    status: AutomationRunOutcomeStatus;
    at?: Date;
    error?: string | null;
    lastRunAt?: Date | 'skip';
  },
): Promise<void> {
  const at = params.at ?? new Date();
  const update: Partial<typeof automations.$inferInsert> = {
    updatedAt: at,
  };

  if (params.lastRunAt !== 'skip') {
    update.lastRunAt = params.lastRunAt ?? at;
  }

  if (params.status === 'failed') {
    update.lastFailedAt = at;
    update.lastError = params.error?.trim() || 'Automation run failed.';
  } else {
    update.lastError = null;

    if (params.status === 'succeeded') {
      update.lastSucceededAt = at;
    }
  }

  await tx
    .update(automations)
    .set(update)
    .where(eq(automations.key, params.key));
}

export async function updateAutomationScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    key: BackgroundAutomationKey;
    cursor: AutomationScanCursor | null;
    updatedAt?: Date;
  },
): Promise<void> {
  await tx
    .update(automations)
    .set({
      scanCursor: params.cursor,
      updatedAt: params.updatedAt ?? new Date(),
    })
    .where(eq(automations.key, params.key));
}

export async function updateSecurityAuditorScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    cursor: SecurityAuditorScanCursor | null;
    updatedAt?: Date;
  },
) {
  return updateAutomationScanCursor(tx, {
    key: 'security_auditor',
    cursor: params.cursor,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
  });
}

export async function updateCodeQualityAuditorScanCursor(
  tx: DatabaseOrTransaction,
  params: {
    cursor: CodeQualityAuditorScanCursor | null;
    updatedAt?: Date;
  },
) {
  return updateAutomationScanCursor(tx, {
    key: 'code_quality_auditor',
    cursor: params.cursor,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
  });
}

/**
 * Runtime view of a single automation for schedulers/runners: enabled +
 * schedule mode + lastRunAt for due-gating, plus resolved Slack channel
 * (automation target -> manager channel fallback) and typed accessors over
 * settings.
 */
export type AutomationRuntime = {
  key: BackgroundAutomationKey;
  enabled: boolean;
  scheduleMode: string | null;
  lastRunAt: Date | null;
  instructions: string | null;
  settings: Record<string, unknown>;
  targets: AutomationTarget[];
  scanCursor: AutomationScanCursor | null;
  /** Automation slack_channel target, falling back to the manager channel. */
  slackChannelId: string | null;
  managerSlackChannelId: string | null;
  /**
   * Provider-neutral destination waterfall result (own target on any comms
   * provider, else the Slack manager channel). Null when neither is set;
   * runners may still fall back to a primary Teams/Telegram conversation.
   */
  destination: AutomationDestination | null;
};

export async function getAutomationRuntime(
  key: BackgroundAutomationKey,
): Promise<AutomationRuntime> {
  await ensureAutomationRowsOnce();

  const [automation, settingsRow] = await Promise.all([
    db.query.automations.findFirst({ where: eq(automations.key, key) }),
    db.query.deploymentSettings.findFirst({
      columns: { managerSlackChannelId: true },
    }),
  ]);

  const managerSlackChannelId = settingsRow?.managerSlackChannelId ?? null;

  return {
    key,
    enabled: automation?.enabled ?? false,
    scheduleMode: getScheduleMode(automation ?? undefined),
    lastRunAt: automation?.lastRunAt ?? null,
    instructions: automation?.instructions ?? null,
    settings: asObject(automation?.settings),
    targets: automation?.targets ?? [],
    scanCursor: automation?.scanCursor ?? null,
    slackChannelId: resolveAutomationSlackChannelId(
      automation ?? undefined,
      managerSlackChannelId,
    ),
    managerSlackChannelId,
    destination: resolveAutomationDestination(
      automation ?? undefined,
      managerSlackChannelId,
    ),
  };
}

export async function ensureDeploymentSettingsRow(): Promise<void> {
  await db.insert(deploymentSettings).values({}).onConflictDoNothing({
    target: deploymentSettings.id,
  });
}

function buildAutomationMap(
  rows: Automation[],
): Map<BackgroundAutomationKey, Automation> {
  return new Map(rows.map((automation) => [automation.key, automation]));
}

function getSuggesterRoutingMode(
  automation: Automation | undefined,
): SuggesterRoutingMode {
  const routingMode = getAutomationSettingText(automation, 'routingMode');

  return routingMode && isSuggesterRoutingMode(routingMode)
    ? routingMode
    : DEFAULT_SUGGESTER_ROUTING_MODE;
}

function getConflictResolverMaxPrAgeDays(
  automation: Automation | undefined,
): ConflictResolverMaxPrAgeDays {
  const maxPrAgeDays = getAutomationSettingNumber(automation, 'maxPrAgeDays');

  return maxPrAgeDays !== null && isConflictResolverMaxPrAgeDays(maxPrAgeDays)
    ? maxPrAgeDays
    : DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS;
}

function isFrequencyOf<T extends string>(modes: readonly T[]) {
  return (value: string): value is T =>
    (modes as readonly string[]).includes(value);
}

/**
 * Flat deployment-wide settings view: the slim background_agent_settings row
 * plus a direct projection of the automations rows. No legacy fallbacks; the
 * automations table is the single source of truth for per-automation state.
 */
export function normalizeBackgroundAgentSettings(
  row: typeof deploymentSettings.$inferSelect | null | undefined,
  automationRows: Automation[] = [],
): BackgroundAgentSettings {
  const now = new Date();
  const automationMap = buildAutomationMap(automationRows);

  const reviewCode = automationMap.get('review_code');
  const conflictResolver = automationMap.get('conflict_resolver');
  const suggester = automationMap.get('suggester');
  const announcer = automationMap.get('announcer');
  const channelAutoStart = automationMap.get('slack_channel_auto_start');
  const managerStats = automationMap.get('manager_stats');
  const sentryTriage = automationMap.get('sentry_triage');
  const dependabotTriage = automationMap.get('dependabot_triage');
  const codeqlTriage = automationMap.get('codeql_triage');
  const issueFixer = automationMap.get('issue_fixer');
  const securityAuditor = automationMap.get('security_auditor');
  const codeQualityAuditor = automationMap.get('code_quality_auditor');
  const ciFailureTriage = automationMap.get('ci_failure_triage');

  const managerSlackChannelId = row?.managerSlackChannelId ?? null;
  const channelAutoStartTargets = getChannelAutoStartTargets(
    channelAutoStart,
    'slack',
    'slack_channel',
  );
  const channelAutoStartDiscordTargets = getChannelAutoStartTargets(
    channelAutoStart,
    'discord',
    'discord_channel',
  );
  const sentryProjectSlugs = getAutomationTargetRefs(
    sentryTriage,
    'sentry',
    'sentry_project',
  );

  return {
    id: row?.id ?? 'default',
    managerSlackChannelId,
    globalAgentInstructions: row?.globalAgentInstructions ?? null,
    createdAt: row?.createdAt ?? now,
    updatedAt: row?.updatedAt ?? now,

    reviewCodeSettings: normalizeReviewCodeAutomationSettings(reviewCode),

    conflictResolverFrequency: getAutomationFrequency(
      conflictResolver,
      isConflictResolverFrequency,
    ),
    conflictResolverLabel:
      getAutomationSettingText(conflictResolver, 'label') ??
      DEFAULT_CONFLICT_RESOLVER_LABEL,
    conflictResolverInstructions: conflictResolver?.instructions ?? null,
    conflictResolverMaxPrAgeDays:
      getConflictResolverMaxPrAgeDays(conflictResolver),
    conflictResolverLastRunAt: conflictResolver?.lastRunAt ?? null,

    suggesterFrequency: getAutomationFrequency(
      suggester,
      isFrequencyOf(SUGGESTER_FREQUENCIES),
    ),
    suggesterInstructions: suggester?.instructions ?? null,
    suggesterRoutingMode: getSuggesterRoutingMode(suggester),
    suggesterRoutingInstructions: getAutomationSettingText(
      suggester,
      'routingInstructions',
    ),
    suggesterLastRunAt: suggester?.lastRunAt ?? null,

    announcerFrequency: getAutomationFrequency(
      announcer,
      isFrequencyOf(ANNOUNCER_FREQUENCIES),
    ),
    announcerInstructions: announcer?.instructions ?? null,
    announcerLastRunAt: announcer?.lastRunAt ?? null,

    channelAutoStartSlackChannels: channelAutoStartTargets,
    channelAutoStartDiscordChannels: channelAutoStartDiscordTargets,
    channelAutoStartEnabled:
      channelAutoStart?.enabled === true &&
      channelAutoStartTargets.length + channelAutoStartDiscordTargets.length >
        0,
    channelAutoStartSlackChannelIds: channelAutoStartTargets.map(
      ({ channelId }) => channelId,
    ),
    channelAutoStartDiscordChannelIds: channelAutoStartDiscordTargets.map(
      ({ channelId }) => channelId,
    ),
    channelAutoStartInstructions:
      channelAutoStartTargets[0]?.instructions ?? null,

    managerStatsFrequency: getAutomationFrequency(
      managerStats,
      isFrequencyOf(MANAGER_STATS_FREQUENCIES),
    ),
    managerStatsLastRunAt: managerStats?.lastRunAt ?? null,

    sentryTriageFrequency: getAutomationFrequency(
      sentryTriage,
      isFrequencyOf(SENTRY_TRIAGE_FREQUENCIES),
    ),
    sentryTriageProjectSlugs:
      sentryProjectSlugs.length > 0 ? sentryProjectSlugs.join('\n') : null,
    sentryTriageLastRunAt: sentryTriage?.lastRunAt ?? null,

    dependabotTriageFrequency: getAutomationFrequency(
      dependabotTriage,
      isFrequencyOf(DEPENDABOT_TRIAGE_FREQUENCIES),
    ),
    dependabotTriageLastRunAt: dependabotTriage?.lastRunAt ?? null,

    codeqlTriageFrequency: getAutomationFrequency(
      codeqlTriage,
      isFrequencyOf(CODEQL_TRIAGE_FREQUENCIES),
    ),
    codeqlTriageLastRunAt: codeqlTriage?.lastRunAt ?? null,

    issueFixerFrequency: getAutomationFrequency(
      issueFixer,
      isFrequencyOf(ISSUE_FIXER_FREQUENCIES),
    ),
    issueFixerLastRunAt: issueFixer?.lastRunAt ?? null,
    issueFixerScanCursor: issueFixer?.scanCursor ?? null,

    securityAuditorFrequency: getAutomationFrequency(
      securityAuditor,
      isFrequencyOf(SECURITY_AUDITOR_FREQUENCIES),
    ),
    securityAuditorLastRunAt: securityAuditor?.lastRunAt ?? null,
    securityAuditorScanCursor: securityAuditor?.scanCursor ?? null,

    codeQualityAuditorFrequency: getAutomationFrequency(
      codeQualityAuditor,
      isFrequencyOf(CODE_QUALITY_AUDITOR_FREQUENCIES),
    ),
    codeQualityAuditorLastRunAt: codeQualityAuditor?.lastRunAt ?? null,
    codeQualityAuditorScanCursor: codeQualityAuditor?.scanCursor ?? null,

    ciFailureTriageFrequency: getAutomationFrequency(
      ciFailureTriage,
      isFrequencyOf(['off', 'daily'] as const),
    ),
    ciFailureTriageLastRunAt: ciFailureTriage?.lastRunAt ?? null,
    ciFailureTriageScanCursor: ciFailureTriage?.scanCursor ?? null,

    ...Object.fromEntries(
      AUTOMATION_DESTINATION_DESCRIPTORS.flatMap((descriptor) => {
        const automation = automationMap.get(descriptor.automationKey);
        const slackChannelId = descriptor.slackSettingsIncludesManagerFallback
          ? resolveAutomationSlackChannelId(automation, managerSlackChannelId)
          : getAutomationSlackChannelTarget(automation);
        const discordChannelId = getAutomationDiscordChannelTarget(automation);

        return [
          [descriptor.slackSettingsKey, slackChannelId],
          [descriptor.discordSettingsKey, discordChannelId],
        ];
      }),
    ),
    suggesterTelegramChatId: getAutomationTelegramChatTarget(suggester),
  } as BackgroundAgentSettings;
}

export async function getBackgroundAgentSettings(): Promise<BackgroundAgentSettings> {
  const [row, automationRows] = await Promise.all([
    db.query.deploymentSettings.findFirst(),
    listAutomations(),
  ]);

  return normalizeBackgroundAgentSettings(row, automationRows);
}

export async function getBackgroundAgentSettingsForDeployment(): Promise<BackgroundAgentSettings> {
  await ensureDeploymentSettingsRow();
  return getBackgroundAgentSettings();
}

/**
 * Discord channel ids configured for channel auto-start, for consumers that
 * only need the monitored-channel set (e.g. the Discord Gateway's forwarding
 * filter) without the full settings projection.
 */
export async function getDiscordAutoStartChannelIds(): Promise<string[]> {
  const automation = await db.query.automations.findFirst({
    columns: { enabled: true, targets: true },
    where: eq(automations.key, 'slack_channel_auto_start'),
  });

  if (!automation?.enabled) {
    return [];
  }

  return getAutomationTargetRefs(automation, 'discord', 'discord_channel');
}

export async function getReviewCodeAutomationSettings(): Promise<PrReviewSettings> {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.key, 'review_code'),
  });

  return normalizeReviewCodeAutomationSettings(automation);
}

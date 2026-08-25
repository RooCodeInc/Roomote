import { createHash } from 'node:crypto';

import {
  db,
  desc,
  eq,
  getAutomationRuntime,
  getProviderUsageLimitSnapshots,
  recordAutomationRunOutcome,
  slackInstallations,
  type ProviderUsageLimitSnapshot,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import { SlackNotifier } from '@roomote/slack';
import {
  DEFAULT_PROVIDER_USAGE_LIMIT_THRESHOLD,
  isProviderUsageLimitThreshold,
  PROVIDER_USAGE_LIMIT_SETTINGS_HASH,
  type ProviderUsageLimitFrequency,
  type ProviderUsageLimitThreshold,
} from '@roomote/types';

import { buildAutomationSettingsMessage } from '../lib/manager-slack';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[providerUsageLimit]';
const REDIS_KEY_PREFIX = 'provider-usage-limit-warning';
const SECONDS_PER_DAY = 24 * 60 * 60;
const FREQUENCY_INTERVAL_MS: Record<
  Exclude<ProviderUsageLimitFrequency, 'off'>,
  number
> = {
  every_15_minutes: 15 * 60 * 1000,
  every_hour: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

type UsageLimitRedis = {
  del: (key: string) => Promise<number>;
  set: (
    key: string,
    value: string,
    expiryMode: 'EX',
    ttl: number,
    setMode: 'NX',
  ) => Promise<string | null>;
};
type UsageLimitNotifier = Pick<SlackNotifier, 'postMessage'>;

type ProviderUsageLimitDependencies = {
  getRuntime: typeof getAutomationRuntime;
  getSlackBotToken: () => Promise<string | null>;
  getSnapshots: () => Promise<ProviderUsageLimitSnapshot[]>;
  getRedisClient: () => UsageLimitRedis;
  createNotifier: (token: string) => UsageLimitNotifier;
  recordOutcome: typeof recordAutomationRunOutcome;
  now: () => Date;
};

const defaultDependencies: ProviderUsageLimitDependencies = {
  getRuntime: getAutomationRuntime,
  getSlackBotToken: getActiveSlackBotToken,
  getSnapshots: getProviderUsageLimitSnapshots,
  getRedisClient: getRedis,
  createNotifier: (token) => new SlackNotifier(token),
  recordOutcome: recordAutomationRunOutcome,
  now: () => new Date(),
};

export async function getActiveSlackBotToken(): Promise<string | null> {
  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    orderBy: [desc(slackInstallations.updatedAt)],
    columns: { botAccessToken: true },
  });
  return installation?.botAccessToken ?? null;
}

function hashKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function inferResetCadence(
  snapshot: ProviderUsageLimitSnapshot,
): string | null {
  const cadence = snapshot.resetCadence?.toLowerCase();
  if (cadence) return cadence;

  const label = snapshot.windowLabel.toLowerCase();
  if (label.includes('daily') || label.includes('24h')) return 'daily';
  if (label.includes('weekly') || label.includes('7d')) return 'weekly';
  if (label.includes('monthly') || label.includes('30d')) return 'monthly';
  return null;
}

export function getProviderUsageLimitPeriodId(
  snapshot: ProviderUsageLimitSnapshot,
  now: Date,
): string {
  if (snapshot.resetsAt) {
    const reset = new Date(snapshot.resetsAt);
    if (!Number.isNaN(reset.getTime())) return `until:${reset.toISOString()}`;
  }

  const cadence = inferResetCadence(snapshot);
  if (cadence === 'daily') return `daily:${now.toISOString().slice(0, 10)}`;
  if (cadence === 'weekly') {
    const weekStart = new Date(now);
    weekStart.setUTCDate(
      weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7),
    );
    weekStart.setUTCHours(0, 0, 0, 0);
    return `weekly:${weekStart.toISOString().slice(0, 10)}`;
  }
  if (cadence === 'monthly') return `monthly:${now.toISOString().slice(0, 7)}`;
  return 'rolling';
}

function getClaimTtlSeconds(
  snapshot: ProviderUsageLimitSnapshot,
  now: Date,
): number {
  if (snapshot.resetsAt) {
    const resetMs = new Date(snapshot.resetsAt).getTime();
    if (Number.isFinite(resetMs) && resetMs > now.getTime()) {
      return Math.ceil((resetMs - now.getTime()) / 1000) + 7 * SECONDS_PER_DAY;
    }
  }

  switch (inferResetCadence(snapshot)) {
    case 'daily':
      return 3 * SECONDS_PER_DAY;
    case 'weekly':
      return 21 * SECONDS_PER_DAY;
    case 'monthly':
      return 62 * SECONDS_PER_DAY;
    default:
      return 45 * SECONDS_PER_DAY;
  }
}

function getClaimKey(params: {
  snapshot: ProviderUsageLimitSnapshot;
  threshold: number;
  periodId: string;
}): string {
  return [
    REDIS_KEY_PREFIX,
    hashKeyPart(params.snapshot.providerId),
    params.snapshot.credentialFingerprint,
    hashKeyPart(params.snapshot.windowLabel),
    hashKeyPart(params.periodId),
    params.threshold,
  ].join(':');
}

async function claimThreshold(params: {
  redis: UsageLimitRedis;
  snapshot: ProviderUsageLimitSnapshot;
  threshold: number;
  now: Date;
}): Promise<string | null> {
  const claimKey = getClaimKey({
    snapshot: params.snapshot,
    threshold: params.threshold,
    periodId: getProviderUsageLimitPeriodId(params.snapshot, params.now),
  });

  if (params.snapshot.usedPercent < params.threshold) {
    await params.redis.del(claimKey);
    return null;
  }

  const result = await params.redis.set(
    claimKey,
    params.now.toISOString(),
    'EX',
    getClaimTtlSeconds(params.snapshot, params.now),
    'NX',
  );
  return result === 'OK' ? claimKey : null;
}

function formatAmount(value: number, currency?: string): string {
  return currency === 'USD'
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value)
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
        value,
      );
}

function formatSnapshot(
  snapshot: ProviderUsageLimitSnapshot,
  threshold: number,
): string {
  const percent = Math.round(snapshot.usedPercent * 10) / 10;
  const usage =
    snapshot.used !== undefined && snapshot.limit !== undefined
      ? `${formatAmount(snapshot.used, snapshot.currency)} / ${formatAmount(snapshot.limit, snapshot.currency)}`
      : `${percent}% / 100% (raw usage and limit not reported)`;

  return [
    `**${snapshot.providerName} usage is at ${percent}%**`,
    `Provider: ${snapshot.providerName}`,
    `Key: ${snapshot.credentialLabel}`,
    `Limit window: ${snapshot.windowLabel}`,
    `Usage: ${usage}`,
    `Threshold crossed: ${threshold}%`,
  ].join('\n');
}

export function buildProviderUsageLimitWarningMessage(params: {
  alerts: Array<{
    snapshot: ProviderUsageLimitSnapshot;
    threshold: number;
  }>;
}) {
  const highestPercent = Math.max(
    ...params.alerts.map(({ snapshot }) => snapshot.usedPercent),
  );
  const summary =
    params.alerts.length === 1
      ? `${params.alerts[0]?.snapshot.providerName} usage is at ${Math.round(highestPercent * 10) / 10}%`
      : `${params.alerts.length} provider usage limits need attention`;
  const message = buildAutomationSettingsMessage(
    params.alerts
      .map(({ snapshot, threshold }) => formatSnapshot(snapshot, threshold))
      .join('\n\n'),
    PROVIDER_USAGE_LIMIT_SETTINGS_HASH,
  );
  return { ...message, text: summary };
}

function isDue(params: {
  frequency: Exclude<ProviderUsageLimitFrequency, 'off'>;
  lastRunAt: Date | null;
  now: Date;
}): boolean {
  return (
    !params.lastRunAt ||
    params.now.getTime() - params.lastRunAt.getTime() >=
      FREQUENCY_INTERVAL_MS[params.frequency]
  );
}

export async function providerUsageLimitJob(
  opts: AutomationRunOpts = {},
  dependencyOverrides: Partial<ProviderUsageLimitDependencies> = {},
): Promise<AutomationJobResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const result = emptyJobResult();
  const runtime = await dependencies.getRuntime('provider_usage_limit');
  const frequency = runtime.enabled ? runtime.scheduleMode : 'off';

  if (
    frequency !== 'every_15_minutes' &&
    frequency !== 'every_hour' &&
    frequency !== 'daily'
  ) {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  const now = dependencies.now();
  if (
    !opts.manualTrigger &&
    !isDue({ frequency, lastRunAt: runtime.lastRunAt, now })
  ) {
    result.skippedReason = 'Not due yet.';
    return result;
  }

  if (opts.destination && opts.destination.provider !== 'slack') {
    result.skippedReason = 'Provider usage limit alerts require Slack.';
    return result;
  }

  const channelId = opts.destination?.channelId ?? runtime.slackChannelId;
  const slackBotToken = await dependencies.getSlackBotToken();
  if (!channelId || !slackBotToken) {
    result.skippedReason = 'Slack channel is not configured.';
    return result;
  }

  const configuredThreshold = runtime.settings.threshold;
  const threshold: ProviderUsageLimitThreshold =
    typeof configuredThreshold === 'number' &&
    isProviderUsageLimitThreshold(configuredThreshold)
      ? configuredThreshold
      : DEFAULT_PROVIDER_USAGE_LIMIT_THRESHOLD;
  const snapshots = await dependencies.getSnapshots();
  const redis = dependencies.getRedisClient();
  const alerts: Array<{
    snapshot: ProviderUsageLimitSnapshot;
    threshold: number;
  }> = [];
  const claimedKeys: string[] = [];

  for (const snapshot of snapshots) {
    const newlyClaimed: Array<{ threshold: number; key: string }> = [];
    for (const candidate of [...new Set([threshold, 100])]) {
      const key = await claimThreshold({
        redis,
        snapshot,
        threshold: candidate,
        now,
      });
      if (key) newlyClaimed.push({ threshold: candidate, key });
    }
    if (newlyClaimed.length > 0) {
      claimedKeys.push(...newlyClaimed.map(({ key }) => key));
      alerts.push({
        snapshot,
        threshold: Math.max(...newlyClaimed.map((claim) => claim.threshold)),
      });
    }
  }

  try {
    if (alerts.length > 0) {
      const notifier = dependencies.createNotifier(slackBotToken);
      const message = buildProviderUsageLimitWarningMessage({ alerts });
      const messageTs = await notifier.postMessage({
        channel: channelId,
        ...message,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!messageTs)
        throw new Error('Failed to post provider usage limit alert');
    }

    await dependencies.recordOutcome(db, {
      key: 'provider_usage_limit',
      status: 'succeeded',
      at: now,
    });
    result.completed = true;
  } catch (error) {
    await Promise.all(claimedKeys.map((key) => redis.del(key)));
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.recordOutcome(db, {
      key: 'provider_usage_limit',
      status: 'failed',
      error: message,
      at: now,
      lastRunAt: 'skip',
    });
    result.errors.push(message);
    console.error(`${LOG_PREFIX} ${message}`);
  }

  return result;
}

import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import {
  db,
  desc,
  eq,
  getBackgroundAgentSettings,
  getProviderUsageLimitSnapshots,
  PROVIDER_USAGE_WARNING_THRESHOLDS,
  slackInstallations,
  type ProviderUsageLimitSnapshot,
  type ProviderUsageWarningThreshold,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

import { getRedis } from '../redis';

const LOG_PREFIX = '[ProviderUsageLimitCheck]';
const REDIS_KEY_PREFIX = 'provider-usage-limit-warning';
const SECONDS_PER_DAY = 24 * 60 * 60;

type UsageLimitRedis = Pick<Redis, 'del' | 'set'>;
type UsageLimitNotifier = Pick<SlackNotifier, 'postMessage'>;

type ProviderUsageLimitCheckDependencies = {
  getManagerSlackChannelId: () => Promise<string | null>;
  getSlackBotToken: () => Promise<string | null>;
  getSnapshots: () => Promise<ProviderUsageLimitSnapshot[]>;
  getRedisClient: () => UsageLimitRedis;
  createNotifier: (token: string) => UsageLimitNotifier;
  now: () => Date;
};

const defaultDependencies: ProviderUsageLimitCheckDependencies = {
  getManagerSlackChannelId: async () =>
    (await getBackgroundAgentSettings()).managerSlackChannelId,
  getSlackBotToken: getActiveSlackBotToken,
  getSnapshots: getProviderUsageLimitSnapshots,
  getRedisClient: getRedis,
  createNotifier: (token) => new SlackNotifier(token),
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
  if (cadence) {
    return cadence;
  }

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
    if (!Number.isNaN(reset.getTime())) {
      return `until:${reset.toISOString()}`;
    }
  }

  const cadence = inferResetCadence(snapshot);
  if (cadence === 'daily') {
    return `daily:${now.toISOString().slice(0, 10)}`;
  }
  if (cadence === 'weekly') {
    const weekStart = new Date(now);
    const daysSinceMonday = (weekStart.getUTCDay() + 6) % 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMonday);
    weekStart.setUTCHours(0, 0, 0, 0);
    return `weekly:${weekStart.toISOString().slice(0, 10)}`;
  }
  if (cadence === 'monthly') {
    return `monthly:${now.toISOString().slice(0, 7)}`;
  }

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
  threshold: ProviderUsageWarningThreshold;
  periodId: string;
}): string {
  const { snapshot, threshold, periodId } = params;
  return [
    REDIS_KEY_PREFIX,
    hashKeyPart(snapshot.providerId),
    snapshot.credentialFingerprint,
    hashKeyPart(snapshot.windowLabel),
    hashKeyPart(periodId),
    threshold,
  ].join(':');
}

async function claimThreshold(params: {
  redis: UsageLimitRedis;
  snapshot: ProviderUsageLimitSnapshot;
  threshold: ProviderUsageWarningThreshold;
  now: Date;
}): Promise<string | null> {
  const { redis, snapshot, threshold, now } = params;
  const claimKey = getClaimKey({
    snapshot,
    threshold,
    periodId: getProviderUsageLimitPeriodId(snapshot, now),
  });

  if (snapshot.usedPercent < threshold) {
    await redis.del(claimKey);
    return null;
  }

  const result = await redis.set(
    claimKey,
    now.toISOString(),
    'EX',
    getClaimTtlSeconds(snapshot, now),
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

function severityForThreshold(threshold: ProviderUsageWarningThreshold): {
  label: string;
  icon: string;
} {
  if (threshold === 100) return { label: 'Critical', icon: ':rotating_light:' };
  if (threshold === 90) return { label: 'High', icon: ':warning:' };
  return { label: 'Warning', icon: ':large_yellow_circle:' };
}

export function buildProviderUsageLimitWarningMessage(params: {
  snapshot: ProviderUsageLimitSnapshot;
  threshold: ProviderUsageWarningThreshold;
}) {
  const { snapshot, threshold } = params;
  const severity = severityForThreshold(threshold);
  const percent = Math.round(snapshot.usedPercent * 10) / 10;
  const usage =
    snapshot.used !== undefined && snapshot.limit !== undefined
      ? `${formatAmount(snapshot.used, snapshot.currency)} / ${formatAmount(snapshot.limit, snapshot.currency)}`
      : `${percent}% / 100% (raw usage and limit not reported)`;
  const text = [
    `${severity.icon} **${severity.label}: ${snapshot.providerName} usage is at ${percent}%**`,
    `Provider: ${snapshot.providerName}`,
    `Key: ${snapshot.credentialLabel}`,
    `Limit window: ${snapshot.windowLabel}`,
    `Usage: ${usage}`,
    `Threshold crossed: ${threshold}%`,
  ].join('\n');

  return {
    text: `${severity.label}: ${snapshot.providerName} usage is at ${percent}%`,
    blocks: [{ type: 'markdown' as const, text }],
  };
}

export async function providerUsageLimitCheckJob(
  dependencyOverrides: Partial<ProviderUsageLimitCheckDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const [channelId, slackBotToken] = await Promise.all([
    dependencies.getManagerSlackChannelId(),
    dependencies.getSlackBotToken(),
  ]);

  if (!channelId || !slackBotToken) {
    console.log(
      `${LOG_PREFIX} Manager Slack channel is not available; skipping`,
    );
    return;
  }

  const snapshots = await dependencies.getSnapshots();
  const redis = dependencies.getRedisClient();
  const notifier = dependencies.createNotifier(slackBotToken);
  const now = dependencies.now();

  for (const snapshot of snapshots) {
    for (const threshold of PROVIDER_USAGE_WARNING_THRESHOLDS) {
      const claimKey = await claimThreshold({
        redis,
        snapshot,
        threshold,
        now,
      });
      if (!claimKey) {
        continue;
      }

      let messageTs: string | undefined;
      try {
        messageTs = await notifier.postMessage({
          channel: channelId,
          ...buildProviderUsageLimitWarningMessage({ snapshot, threshold }),
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (error) {
        await redis.del(claimKey);
        throw error;
      }
      if (!messageTs) {
        await redis.del(claimKey);
        throw new Error(
          `${LOG_PREFIX} Failed to post ${snapshot.providerId} ${threshold}% warning`,
        );
      }

      console.log(
        `${LOG_PREFIX} Posted ${snapshot.providerId} ${snapshot.windowLabel} ${threshold}% warning`,
      );
    }
  }
}

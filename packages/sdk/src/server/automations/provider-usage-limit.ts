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
  type ProviderUsageLimitThreshold,
  type SlackBlock,
} from '@roomote/types';

import { getCommunicationProviderAdapter } from '../lib/communication-providers';
import {
  buildAutomationIconUrl,
  buildManagerSlackSettingsUrl,
  degradeSlackMrkdwnToMarkdown,
} from '../lib/manager-slack';
import {
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[providerUsageLimit]';
const REDIS_KEY_PREFIX = 'provider-usage-limit-warning';
const SECONDS_PER_DAY = 24 * 60 * 60;

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
type UsageLimitCommunicationAdapter = Awaited<
  ReturnType<typeof getCommunicationProviderAdapter>
>;

type ProviderUsageLimitDependencies = {
  getRuntime: typeof getAutomationRuntime;
  getSlackBotToken: () => Promise<string | null>;
  getSnapshots: () => Promise<ProviderUsageLimitSnapshot[]>;
  getRedisClient: () => UsageLimitRedis;
  createNotifier: (token: string) => UsageLimitNotifier;
  resolveDestination: typeof resolveAutomationRuntimeDestination;
  getCommunicationAdapter: typeof getCommunicationProviderAdapter;
  recordOutcome: typeof recordAutomationRunOutcome;
  now: () => Date;
};

const defaultDependencies: ProviderUsageLimitDependencies = {
  getRuntime: (key) => getAutomationRuntime(key),
  getSlackBotToken: getActiveSlackBotToken,
  getSnapshots: () => getProviderUsageLimitSnapshots(),
  getRedisClient: getRedis,
  createNotifier: (token) => new SlackNotifier(token),
  resolveDestination: resolveAutomationRuntimeDestination,
  getCommunicationAdapter: getCommunicationProviderAdapter,
  recordOutcome: (executor, params) =>
    recordAutomationRunOutcome(executor, params),
  now: () => new Date(),
};

async function getActiveSlackBotToken(): Promise<string | null> {
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

type ProviderUsageLimitAlert = {
  snapshot: ProviderUsageLimitSnapshot;
  threshold: number;
  manualTest?: boolean;
};

function formatUsage(snapshot: ProviderUsageLimitSnapshot, percent: number) {
  return snapshot.used !== undefined && snapshot.limit !== undefined
    ? `${formatAmount(snapshot.used, snapshot.currency)} of ${formatAmount(snapshot.limit, snapshot.currency)}`
    : `${percent}% of 100% (raw usage and limit not reported)`;
}

function formatCredentialLabel(snapshot: ProviderUsageLimitSnapshot) {
  return snapshot.credentialLabel.endsWith(
    ` (${snapshot.credentialFingerprint})`,
  )
    ? snapshot.credentialLabel.slice(
        0,
        -` (${snapshot.credentialFingerprint})`.length,
      )
    : snapshot.credentialLabel;
}

function formatSnapshot({
  snapshot,
  threshold,
  manualTest = false,
}: ProviderUsageLimitAlert): string {
  const percent = Math.round(snapshot.usedPercent * 10) / 10;
  const usage = formatUsage(snapshot, percent);
  const credentialLabel = formatCredentialLabel(snapshot);

  return [
    `*Provider* ${snapshot.providerName}`,
    `*Usage* ${usage}`,
    `*Limit window* ${snapshot.windowLabel}`,
    `*Key* \`${credentialLabel}\``,
    manualTest ? null : `*Threshold crossed* ${threshold}%`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function buildProviderUsageLimitAlertBlock(
  snapshot: ProviderUsageLimitSnapshot,
): SlackBlock {
  const percent = Math.round(snapshot.usedPercent * 10) / 10;
  const usage = formatUsage(snapshot, percent);
  const credentialLabel = formatCredentialLabel(snapshot);

  return {
    type: 'container',
    width: 'full',
    title: {
      type: 'plain_text',
      text: 'Inference Provider Usage Alert',
      emoji: false,
    },
    subtitle: {
      type: 'mrkdwn',
      text: `${snapshot.providerName} (\`${credentialLabel}\`) is at ${percent}% (${usage})`,
    },
    icon: {
      type: 'image',
      image_url: buildAutomationIconUrl('battery-warning'),
      alt_text: 'Inference Provider Usage Alert automation icon',
    },
    child_blocks: [],
  };
}

export function buildProviderUsageLimitWarningMessage(params: {
  alerts: ProviderUsageLimitAlert[];
}) {
  const highestPercent = Math.max(
    ...params.alerts.map(({ snapshot }) => snapshot.usedPercent),
  );
  const summary =
    params.alerts.length === 1
      ? `${params.alerts[0]?.snapshot.providerName} usage is at ${Math.round(highestPercent * 10) / 10}%`
      : `${params.alerts.length} provider usage limits need attention`;
  return {
    text: summary,
    blocks: params.alerts.map(({ snapshot }) =>
      buildProviderUsageLimitAlertBlock(snapshot),
    ),
  };
}

function formatProviderUsageLimitWarningText(params: {
  alerts: ProviderUsageLimitAlert[];
}): string {
  return params.alerts.map(formatSnapshot).join('\n\n');
}

async function postProviderUsageLimitViaCommunicationAdapter(params: {
  adapter: NonNullable<UsageLimitCommunicationAdapter>;
  destination: ResolvedAutomationDestination;
  alerts: ProviderUsageLimitAlert[];
}): Promise<void> {
  await params.adapter.postMessage({
    channelId: params.destination.channelId,
    ...(params.destination.serviceUrl
      ? { serviceUrl: params.destination.serviceUrl }
      : {}),
    text: degradeSlackMrkdwnToMarkdown(
      formatProviderUsageLimitWarningText({ alerts: params.alerts }),
    ),
    textFormat: 'markdown',
    buttons: [
      [
        {
          text: 'Automation settings',
          url: buildManagerSlackSettingsUrl(PROVIDER_USAGE_LIMIT_SETTINGS_HASH),
        },
      ],
    ],
  });
}

export async function providerUsageLimitJob(
  opts: AutomationRunOpts = {},
  dependencyOverrides: Partial<ProviderUsageLimitDependencies> = {},
): Promise<AutomationJobResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const result = emptyJobResult();
  const runtime = await dependencies.getRuntime('provider_usage_limit');

  if (!runtime.enabled) {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  const now = dependencies.now();
  const slackBotToken = await dependencies.getSlackBotToken();
  const destination =
    opts.destination ??
    (await dependencies.resolveDestination({
      runtime,
      slackConnected: Boolean(slackBotToken),
    }));
  if (!destination) {
    result.skippedReason =
      'Provider usage limit alert channel is not configured.';
    return result;
  }

  if (destination.provider === 'slack' && !slackBotToken) {
    result.skippedReason = 'Slack is not connected.';
    return result;
  }

  const configuredThreshold = runtime.settings.threshold;
  const threshold: ProviderUsageLimitThreshold =
    typeof configuredThreshold === 'number' &&
    isProviderUsageLimitThreshold(configuredThreshold)
      ? configuredThreshold
      : DEFAULT_PROVIDER_USAGE_LIMIT_THRESHOLD;
  const snapshots = await dependencies.getSnapshots();
  const alerts: ProviderUsageLimitAlert[] = opts.manualTrigger
    ? snapshots.map((snapshot) => ({
        snapshot,
        threshold,
        manualTest: true,
      }))
    : [];
  const claimedKeys: string[] = [];

  if (!opts.manualTrigger) {
    const redis = dependencies.getRedisClient();
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
  }

  try {
    if (alerts.length > 0) {
      if (destination.provider === 'slack') {
        const notifier = dependencies.createNotifier(slackBotToken!);
        const message = buildProviderUsageLimitWarningMessage({ alerts });
        const messageTs = await notifier.postMessage({
          channel: destination.channelId,
          ...message,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!messageTs) {
          throw new Error('Failed to post provider usage limit alert');
        }
      } else {
        const adapter = await dependencies.getCommunicationAdapter(
          destination.provider,
        );
        if (!adapter) {
          throw new Error(
            `Failed to post provider usage limit alert: ${destination.provider} is not connected`,
          );
        }
        await postProviderUsageLimitViaCommunicationAdapter({
          adapter,
          destination,
          alerts,
        });
      }
    }

    await dependencies.recordOutcome(db, {
      key: 'provider_usage_limit',
      status: 'succeeded',
      at: now,
    });
    result.completed = true;
  } catch (error) {
    if (claimedKeys.length > 0) {
      const redis = dependencies.getRedisClient();
      await Promise.all(claimedKeys.map((key) => redis.del(key)));
    }
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

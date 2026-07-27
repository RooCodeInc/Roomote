import {
  ZAI_USAGE_HOSTS,
  ZAI_USAGE_QUOTA_PATH,
  type SubscriptionProviderUsage,
  type SubscriptionUsageProviderId,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { resolveModelProviderEnvValue } from '../model-runtime-config';
import {
  asRecord,
  clampPercent,
  fetchJson,
  firstNumber,
  firstString,
  toResetIso,
  type UsageFetchOptions,
} from './shared';

function label(type: string | undefined, unit: number | undefined): string {
  if (unit === 3) return '5h limit';
  if (unit === 6) return 'Weekly limit';
  if (unit === 5)
    return type === 'TIME_LIMIT' ? 'Monthly tools' : 'Monthly limit';
  return type === 'TOKENS_LIMIT'
    ? 'Token limit'
    : type === 'TIME_LIMIT'
      ? 'Time limit'
      : 'Usage';
}

function parseLimit(
  entry: Record<string, unknown> | undefined,
): SubscriptionUsageWindow | undefined {
  if (!entry) return undefined;
  const type = firstString(entry, ['type']);
  const unit = firstNumber(entry, ['unit']);
  const percent = firstNumber(entry, [
    'percentage',
    'percent',
    'used_percent',
    'usedPercent',
  ]);
  const remaining = firstNumber(entry, ['remaining', 'remain']);
  const limit = firstNumber(entry, ['limit', 'total', 'quota', 'usage']);
  const used = firstNumber(entry, [
    'used',
    'consumed',
    'currentValue',
    'current_value',
  ]);
  if (
    percent === undefined &&
    remaining === undefined &&
    limit === undefined &&
    used === undefined
  )
    return undefined;
  const usedPercent =
    percent ??
    (limit !== undefined && limit > 0 && remaining !== undefined
      ? clampPercent(((limit - remaining) / limit) * 100)
      : used !== undefined && limit !== undefined && limit > 0
        ? clampPercent((used / limit) * 100)
        : undefined);
  const resetsAt = toResetIso(
    entry.nextResetTime ??
      entry.next_reset_time ??
      entry.resetTime ??
      entry.resets_at,
  );
  return {
    label: label(type, unit),
    ...(usedPercent !== undefined && {
      usedPercent: clampPercent(usedPercent),
    }),
    ...(used !== undefined && { used }),
    ...(remaining !== undefined && { remaining }),
    ...(limit !== undefined && { limit }),
    ...(resetsAt && { resetsAt }),
  };
}

export function parseZaiQuotaUsage(payload: unknown): {
  planType?: string;
  windows: SubscriptionUsageWindow[];
} {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const planType = firstString(data, [
    'level',
    'plan',
    'planType',
    'plan_type',
  ]);
  const raw =
    (data && (data.limits ?? data.limit)) ??
    (Array.isArray(payload) ? payload : undefined) ??
    (Array.isArray(root?.limits) ? root.limits : undefined);
  const windows = Array.isArray(raw)
    ? raw
        .map((entry) => parseLimit(asRecord(entry)))
        .filter(
          (window): window is SubscriptionUsageWindow => window !== undefined,
        )
    : [];
  return { ...(planType && { planType }), windows };
}

async function fetchZaiFamilyUsage(
  options: UsageFetchOptions,
  config: {
    providerId: Extract<SubscriptionUsageProviderId, 'zai' | 'zai-coding-plan'>;
    apiKeyEnvNames: readonly string[];
    regionEnvNames: readonly string[];
  },
): Promise<SubscriptionProviderUsage | null> {
  const apiKey = await resolveModelProviderEnvValue(config.apiKeyEnvNames, {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });
  if (!apiKey) return null;
  const region = await resolveModelProviderEnvValue(config.regionEnvNames, {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });
  const host =
    region === 'china' ? ZAI_USAGE_HOSTS.china : ZAI_USAGE_HOSTS.global;
  const { status, payload } = await fetchJson(
    options.fetchImpl ?? fetch,
    `${host}${ZAI_USAGE_QUOTA_PATH}`,
    {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'user-agent': 'roomote',
    },
  );
  const root = asRecord(payload);
  const code = firstNumber(root, ['code']);
  if (
    status !== 200 ||
    root?.success === false ||
    (code !== undefined && code !== 200)
  )
    return null;
  const parsed = parseZaiQuotaUsage(payload);
  return parsed.windows.length > 0
    ? {
        providerId: config.providerId,
        ...(parsed.planType && { planType: parsed.planType }),
        windows: parsed.windows,
        fetchedAt: new Date().toISOString(),
      }
    : null;
}

export function fetchZaiUsage(options: UsageFetchOptions = {}) {
  return fetchZaiFamilyUsage(options, {
    providerId: 'zai',
    apiKeyEnvNames: ['ZAI_API_KEY'],
    regionEnvNames: ['ZAI_REGION'],
  });
}
export function fetchZaiCodingPlanUsage(options: UsageFetchOptions = {}) {
  return fetchZaiFamilyUsage(options, {
    providerId: 'zai-coding-plan',
    apiKeyEnvNames: ['ZAI_CODING_PLAN_API_KEY'],
    regionEnvNames: ['ZAI_CODING_PLAN_REGION'],
  });
}

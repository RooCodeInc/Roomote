import {
  KIMI_FOR_CODING_USAGE_ENDPOINTS,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { resolveModelProviderEnvValue } from '../model-runtime-config';
import {
  asRecord,
  clampPercent,
  fetchJson,
  firstNumber,
  firstString,
  formatWindowLabel,
  resetFromRelativeSeconds,
  toResetIso,
  type UsageFetchOptions,
} from './shared';

function parseEntry(
  entry: Record<string, unknown> | undefined,
  label: string,
  now: number,
): SubscriptionUsageWindow | undefined {
  if (!entry) return undefined;
  const limit = firstNumber(entry, ['limit', 'limit_amount', 'total']);
  let used = firstNumber(entry, ['used', 'used_amount']);
  let remaining = firstNumber(entry, ['remaining', 'remaining_amount']);
  if (remaining === undefined && limit !== undefined && used !== undefined)
    remaining = limit - used;
  if (used === undefined && limit !== undefined && remaining !== undefined)
    used = limit - remaining;
  if (limit === undefined && used === undefined && remaining === undefined)
    return undefined;
  const resetsAt =
    toResetIso(entry.resetTime ?? entry.reset_time ?? entry.reset_at) ??
    resetFromRelativeSeconds(
      firstNumber(entry, ['reset_in', 'resets_in_seconds']),
      now,
    );
  return {
    label,
    ...(limit !== undefined &&
      limit > 0 &&
      used !== undefined && {
        usedPercent: clampPercent((used / limit) * 100),
      }),
    ...(used !== undefined && { used }),
    ...(remaining !== undefined && { remaining }),
    ...(limit !== undefined && { limit }),
    ...(resetsAt && { resetsAt }),
  };
}

function label(window: Record<string, unknown> | undefined): string {
  const duration = firstNumber(window, ['duration']);
  const unit = firstString(window, ['timeUnit', 'time_unit'])
    ?.toUpperCase()
    .replace(/^TIME_UNIT_/, '');
  const minutes = unit
    ? (
        { MINUTE: 1, HOUR: 60, DAY: 1440, WEEK: 10080, MONTH: 43200 } as Record<
          string,
          number
        >
      )[unit]
    : undefined;
  return (
    formatWindowLabel(
      duration !== undefined && minutes !== undefined
        ? duration * minutes
        : undefined,
    ) ?? 'Usage'
  );
}

function parseKimiForCodingUsage(
  payload: unknown,
  now: number,
): SubscriptionUsageWindow[] {
  const root = asRecord(payload);
  if (!root) return [];
  if (Array.isArray(root.data)) {
    const rows = root.data
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined);
    const summary =
      rows.find((row) => row.model_name === 'all') ??
      (rows.length === 1 ? rows[0] : undefined);
    const window = parseEntry(
      summary,
      firstString(summary, ['name', 'title']) ?? 'Weekly limit',
      now,
    );
    return window ? [window] : [];
  }
  const windows: SubscriptionUsageWindow[] = [];
  if (Array.isArray(root.limits))
    for (const raw of root.limits) {
      const limit = asRecord(raw);
      const window = parseEntry(
        asRecord(limit?.detail) ?? limit,
        label(asRecord(limit?.window)),
        now,
      );
      if (window) windows.push(window);
    }
  const plan = parseEntry(
    asRecord(root.usage),
    windows.length > 0 ? 'Weekly limit' : 'Usage',
    now,
  );
  if (plan) windows.push(plan);
  return windows;
}

export async function fetchKimiForCodingUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const apiKey = await resolveModelProviderEnvValue(['KIMI_API_KEY'], {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });
  if (!apiKey) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const endpoint of KIMI_FOR_CODING_USAGE_ENDPOINTS) {
    const { status, payload } = await fetchJson(fetchImpl, endpoint, {
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      accept: 'application/json',
      'user-agent': 'KimiCLI/1.6',
    });
    if (status === 404) continue;
    const windows = parseKimiForCodingUsage(payload, Date.now());
    return windows.length > 0
      ? {
          providerId: 'kimi-for-coding',
          windows,
          fetchedAt: new Date().toISOString(),
        }
      : null;
  }
  return null;
}

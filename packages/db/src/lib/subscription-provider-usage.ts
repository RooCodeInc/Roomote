import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_USAGE_ENDPOINT,
  GITHUB_COPILOT_USAGE_ENDPOINT,
  KIMI_FOR_CODING_USAGE_ENDPOINTS,
  ZAI_USAGE_HOSTS,
  ZAI_USAGE_QUOTA_PATH,
  type SubscriptionProviderUsage,
  type SubscriptionUsageProviderId,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { getFreshChatGptAccessToken } from './chatgpt-subscription';
import { getGitHubCopilotAccessToken } from './github-copilot-subscription';
import { resolveModelProviderEnvValue } from './model-runtime-config';

/**
 * Server-side usage/quota lookups for subscription-style inference providers,
 * using the same credentials the inference gateway already holds. Upstream
 * endpoints are undocumented (each is what the provider's own CLI polls), so
 * every fetcher parses defensively and resolves to `null` on any failure —
 * the settings UI omits the usage line rather than erroring.
 */

const USAGE_FETCH_TIMEOUT_MS = 10_000;

type UsageFetchOptions = {
  executor?: DatabaseOrTransaction;
  fetchImpl?: typeof fetch;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Kimi's usage payload serializes numbers as strings, so coerce both. */
function firstNumber(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstString(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Epoch reset values appear as seconds or milliseconds; ISO strings too. */
function toResetIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

function resetFromRelativeSeconds(seconds: number | undefined, now: number) {
  return seconds !== undefined && seconds >= 0
    ? new Date(now + seconds * 1000).toISOString()
    : undefined;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { status: response.status, payload: undefined };
  }

  try {
    return { status: response.status, payload: await response.json() };
  } catch {
    return { status: response.status, payload: undefined };
  }
}

// --- GitHub Copilot -------------------------------------------------------

function parseGitHubCopilotUsage(payload: unknown): SubscriptionUsageWindow[] {
  const root = asRecord(payload);
  const premium = asRecord(
    asRecord(root?.quota_snapshots)?.premium_interactions,
  );

  if (!premium) {
    return [];
  }

  const entitlement = firstNumber(premium, ['entitlement']);
  const remaining = firstNumber(premium, ['remaining', 'quota_remaining']);
  const percentRemaining = firstNumber(premium, ['percent_remaining']);
  const unlimited = premium.unlimited === true;
  const resetsAt = toResetIso(firstString(root, ['quota_reset_date']));

  const usedPercent =
    percentRemaining !== undefined
      ? clampPercent(100 - percentRemaining)
      : entitlement && remaining !== undefined
        ? clampPercent(((entitlement - remaining) / entitlement) * 100)
        : undefined;

  if (!unlimited && usedPercent === undefined && remaining === undefined) {
    return [];
  }

  return [
    {
      label: 'Premium requests',
      ...(usedPercent !== undefined && { usedPercent }),
      ...(entitlement !== undefined &&
        remaining !== undefined && {
          used: Math.max(0, Math.round(entitlement - remaining)),
        }),
      ...(remaining !== undefined && { remaining: Math.round(remaining) }),
      ...(entitlement !== undefined && { limit: entitlement }),
      ...(unlimited && { unlimited }),
      ...(resetsAt && { resetsAt }),
    },
  ];
}

export async function fetchGitHubCopilotUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getGitHubCopilotAccessToken(options.executor);

  if (!token) {
    return null;
  }

  // Editor headers mirror the OpenCode Copilot plugin whose client id minted
  // this token; copilot_internal rejects requests it cannot attribute to an
  // editor integration.
  const { payload } = await fetchJson(
    fetchImpl,
    GITHUB_COPILOT_USAGE_ENDPOINT,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'GitHubCopilotChat/0.26.7',
      'editor-version': 'vscode/1.99.3',
      'editor-plugin-version': 'copilot-chat/0.26.7',
    },
  );

  const windows = parseGitHubCopilotUsage(payload);

  if (windows.length === 0) {
    return null;
  }

  return {
    providerId: 'github-copilot',
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

// --- ChatGPT subscription -------------------------------------------------

function formatWindowLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined || minutes <= 0) {
    return undefined;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 7 ? 'Weekly limit' : `${days}d limit`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h limit`;
  }
  return `${minutes}m limit`;
}

function parseChatGptWindow(
  window: Record<string, unknown> | undefined,
  fallbackLabel: string,
  now: number,
): SubscriptionUsageWindow | undefined {
  if (!window) {
    return undefined;
  }

  let usedPercent = firstNumber(window, ['used_percent', 'usedPercent']);
  if (usedPercent === undefined) {
    const percentLeft = firstNumber(window, [
      'percent_left',
      'remaining_percent',
    ]);
    if (percentLeft !== undefined) {
      usedPercent = 100 - percentLeft;
    }
  }

  if (usedPercent === undefined) {
    return undefined;
  }

  const windowSeconds = firstNumber(window, [
    'limit_window_seconds',
    'window_seconds',
  ]);
  const windowMinutes =
    firstNumber(window, [
      'window_minutes',
      'window_duration_mins',
      'windowDurationMins',
    ]) ?? (windowSeconds !== undefined ? windowSeconds / 60 : undefined);

  const resetsAt =
    toResetIso(window['resets_at'] ?? window['reset_at']) ??
    resetFromRelativeSeconds(
      firstNumber(window, ['resets_in_seconds', 'reset_after_seconds']),
      now,
    );

  return {
    label: formatWindowLabel(windowMinutes) ?? fallbackLabel,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt && { resetsAt }),
  };
}

function parseChatGptUsage(
  payload: unknown,
  now: number,
): { planType?: string; windows: SubscriptionUsageWindow[] } {
  const root = asRecord(payload);

  if (!root) {
    return { windows: [] };
  }

  const planType = firstString(root, ['plan_type', 'planType']);
  // The live endpoint nests windows under singular `rate_limit`; older
  // payloads used `rate_limits` (object or array of limit entries).
  const rawRateLimits = root.rate_limits ?? root.rateLimits ?? root.rate_limit;
  const rateLimits = Array.isArray(rawRateLimits)
    ? asRecord(
        rawRateLimits.find((entry) => asRecord(entry)?.limit_id === 'codex') ??
          rawRateLimits[0],
      )
    : asRecord(rawRateLimits);

  const primary = parseChatGptWindow(
    asRecord(
      rateLimits?.primary ??
        rateLimits?.primary_window ??
        rateLimits?.five_hour,
    ),
    '5h limit',
    now,
  );
  const secondary = parseChatGptWindow(
    asRecord(
      rateLimits?.secondary ??
        rateLimits?.secondary_window ??
        rateLimits?.weekly,
    ),
    'Weekly limit',
    now,
  );

  return {
    ...(planType && { planType }),
    windows: [primary, secondary].filter(
      (window): window is SubscriptionUsageWindow => window !== undefined,
    ),
  };
}

export async function fetchChatGptUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fresh = await getFreshChatGptAccessToken({
    ...(options.executor && { executor: options.executor }),
    fetchImpl,
  });

  if (!fresh) {
    return null;
  }

  const { payload } = await fetchJson(fetchImpl, CHATGPT_USAGE_ENDPOINT, {
    authorization: `Bearer ${fresh.access}`,
    accept: 'application/json',
    'user-agent': 'roomote',
    origin: 'https://chatgpt.com',
    ...(fresh.accountId && { [CHATGPT_ACCOUNT_ID_HEADER]: fresh.accountId }),
  });

  const { planType, windows } = parseChatGptUsage(payload, Date.now());

  if (windows.length === 0) {
    return null;
  }

  return {
    providerId: 'chatgpt',
    ...(planType && { planType }),
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

// --- Kimi for Coding ------------------------------------------------------

const KIMI_LIMIT_KEYS = ['limit', 'limit_amount', 'total'] as const;
const KIMI_USED_KEYS = ['used', 'used_amount'] as const;
const KIMI_REMAINING_KEYS = ['remaining', 'remaining_amount'] as const;

function parseKimiEntry(
  entry: Record<string, unknown> | undefined,
  label: string,
  now: number,
): SubscriptionUsageWindow | undefined {
  if (!entry) {
    return undefined;
  }

  const limit = firstNumber(entry, KIMI_LIMIT_KEYS);
  let used = firstNumber(entry, KIMI_USED_KEYS);
  let remaining = firstNumber(entry, KIMI_REMAINING_KEYS);

  if (remaining === undefined && limit !== undefined && used !== undefined) {
    remaining = limit - used;
  }
  if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = limit - remaining;
  }

  if (limit === undefined && used === undefined && remaining === undefined) {
    return undefined;
  }

  const resetsAt =
    toResetIso(
      entry['resetTime'] ?? entry['reset_time'] ?? entry['reset_at'],
    ) ??
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

function kimiWindowLabel(window: Record<string, unknown> | undefined): string {
  const duration = firstNumber(window, ['duration']);
  const timeUnit = firstString(window, ['timeUnit', 'time_unit']);

  if (duration === undefined || !timeUnit) {
    return 'Usage';
  }

  const minutesPerUnit: Record<string, number> = {
    MINUTE: 1,
    HOUR: 60,
    DAY: 1440,
    WEEK: 10080,
    MONTH: 43200,
  };
  // The live API reports proto-style enum values like 'TIME_UNIT_MINUTE'.
  const normalizedUnit = timeUnit.toUpperCase().replace(/^TIME_UNIT_/, '');
  const minutes = minutesPerUnit[normalizedUnit];

  return (
    (minutes !== undefined
      ? formatWindowLabel(duration * minutes)
      : undefined) ?? 'Usage'
  );
}

function parseKimiForCodingUsage(
  payload: unknown,
  now: number,
): SubscriptionUsageWindow[] {
  const root = asRecord(payload);

  if (!root) {
    return [];
  }

  // Variant A: { data: [{ model_name, limit, used, remaining, ... }] } where
  // model_name 'all' is the plan-wide summary row.
  if (Array.isArray(root.data)) {
    const rows = root.data
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined);
    const summary =
      rows.find((row) => row.model_name === 'all') ??
      (rows.length === 1 ? rows[0] : undefined);

    if (summary) {
      const window = parseKimiEntry(
        summary,
        firstString(summary, ['name', 'title']) ?? 'Weekly limit',
        now,
      );
      return window ? [window] : [];
    }

    return [];
  }

  // Variant B (the live shape): { usage: {...}, limits: [{ detail, window:
  // { duration, timeUnit } }] }. `limits` carries the short rate-limit
  // windows (e.g. 300 minutes); top-level `usage` is the plan quota, which
  // resets weekly on Kimi for Coding plans.
  const windows: SubscriptionUsageWindow[] = [];

  if (Array.isArray(root.limits)) {
    for (const rawLimit of root.limits) {
      const limitRecord = asRecord(rawLimit);
      const window = parseKimiEntry(
        asRecord(limitRecord?.detail) ?? limitRecord,
        kimiWindowLabel(asRecord(limitRecord?.window)),
        now,
      );
      if (window) {
        windows.push(window);
      }
    }
  }

  const planUsage = parseKimiEntry(
    asRecord(root.usage),
    windows.length > 0 ? 'Weekly limit' : 'Usage',
    now,
  );
  if (planUsage) {
    windows.push(planUsage);
  }

  return windows;
}

export async function fetchKimiForCodingUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = await resolveModelProviderEnvValue(['KIMI_API_KEY'], {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });

  if (!apiKey) {
    return null;
  }

  for (const endpoint of KIMI_FOR_CODING_USAGE_ENDPOINTS) {
    // Both auth header styles are sent: inference uses x-api-key while the
    // usage endpoint is known to accept bearer auth. The Kimi CLI user-agent
    // matches the client this endpoint is built for.
    const { status, payload } = await fetchJson(fetchImpl, endpoint, {
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      accept: 'application/json',
      'user-agent': 'KimiCLI/1.6',
    });

    if (status === 404) {
      continue;
    }

    const windows = parseKimiForCodingUsage(payload, Date.now());

    if (windows.length === 0) {
      return null;
    }

    return {
      providerId: 'kimi-for-coding',
      windows,
      fetchedAt: new Date().toISOString(),
    };
  }

  return null;
}

// --- Z.AI / Z.AI Coding Plan ----------------------------------------------

/**
 * Unit values observed in the Z.AI monitor quota UI / Coding Plan tools:
 * 3 = 5-hour token window, 6 = weekly token window, 5 = monthly tool quota.
 */
function zaiQuotaWindowLabel(
  type: string | undefined,
  unit: number | undefined,
): string {
  if (unit === 3) {
    // Match ChatGPT's compact window label convention (`5h limit`).
    return '5h limit';
  }
  if (unit === 6) {
    return 'Weekly limit';
  }
  if (unit === 5) {
    return type === 'TIME_LIMIT' ? 'Monthly tools' : 'Monthly limit';
  }
  if (type === 'TOKENS_LIMIT') {
    return 'Token limit';
  }
  if (type === 'TIME_LIMIT') {
    return 'Time limit';
  }
  return 'Usage';
}

function parseZaiQuotaLimitEntry(
  entry: Record<string, unknown> | undefined,
): SubscriptionUsageWindow | undefined {
  if (!entry) {
    return undefined;
  }

  const type = firstString(entry, ['type']);
  const unit = firstNumber(entry, ['unit']);
  const usedPercent = firstNumber(entry, [
    'percentage',
    'percent',
    'used_percent',
    'usedPercent',
  ]);
  const remaining = firstNumber(entry, ['remaining', 'remain']);
  // Live TIME_LIMIT rows use `usage` as the cap and `currentValue` as spent.
  const limit = firstNumber(entry, ['limit', 'total', 'quota', 'usage']);
  const used = firstNumber(entry, [
    'used',
    'consumed',
    'currentValue',
    'current_value',
  ]);
  const resetsAt = toResetIso(
    entry.nextResetTime ??
      entry.next_reset_time ??
      entry.resetTime ??
      entry.resets_at,
  );

  if (
    usedPercent === undefined &&
    remaining === undefined &&
    limit === undefined &&
    used === undefined
  ) {
    return undefined;
  }

  const derivedPercent =
    usedPercent ??
    (limit !== undefined &&
    limit > 0 &&
    remaining !== undefined &&
    Number.isFinite(remaining)
      ? clampPercent(((limit - remaining) / limit) * 100)
      : used !== undefined && limit !== undefined && limit > 0
        ? clampPercent((used / limit) * 100)
        : undefined);

  return {
    label: zaiQuotaWindowLabel(type, unit),
    ...(derivedPercent !== undefined && {
      usedPercent: clampPercent(derivedPercent),
    }),
    ...(used !== undefined && { used }),
    ...(remaining !== undefined && { remaining }),
    ...(limit !== undefined && { limit }),
    ...(resetsAt && { resetsAt }),
  };
}

/**
 * Parse Z.AI monitor quota payloads. Live shape:
 * `{ code: 200, data: { level, limits: [{ type, unit, percentage, nextResetTime }] } }`.
 * Older tools also report a bare array of limit rows. Exported for tests.
 */
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

  const rawLimits =
    (data && (data.limits ?? data.limit)) ??
    (Array.isArray(payload) ? payload : undefined) ??
    (Array.isArray(root?.limits) ? root.limits : undefined);

  const windows: SubscriptionUsageWindow[] = [];
  if (Array.isArray(rawLimits)) {
    for (const raw of rawLimits) {
      const window = parseZaiQuotaLimitEntry(asRecord(raw));
      if (window) {
        windows.push(window);
      }
    }
  }

  return {
    ...(planType && { planType }),
    windows,
  };
}

function resolveZaiUsageHost(
  region: string | null | undefined,
): (typeof ZAI_USAGE_HOSTS)[keyof typeof ZAI_USAGE_HOSTS] {
  return region === 'china' ? ZAI_USAGE_HOSTS.china : ZAI_USAGE_HOSTS.global;
}

async function fetchZaiFamilyUsage(
  options: UsageFetchOptions,
  config: {
    providerId: Extract<SubscriptionUsageProviderId, 'zai' | 'zai-coding-plan'>;
    apiKeyEnvNames: readonly string[];
    regionEnvNames: readonly string[];
  },
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = await resolveModelProviderEnvValue(config.apiKeyEnvNames, {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });

  if (!apiKey) {
    return null;
  }

  const region = await resolveModelProviderEnvValue(config.regionEnvNames, {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });

  const endpoint = `${resolveZaiUsageHost(region)}${ZAI_USAGE_QUOTA_PATH}`;
  const { status, payload } = await fetchJson(fetchImpl, endpoint, {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'user-agent': 'roomote',
  });

  if (status !== 200) {
    return null;
  }

  // The monitor API often returns HTTP 200 with a business error envelope
  // (`code: 1000`, `success: false`) for bad keys — treat as no usage.
  const root = asRecord(payload);
  const businessCode = firstNumber(root, ['code']);
  if (
    root?.success === false ||
    (businessCode !== undefined && businessCode !== 200)
  ) {
    return null;
  }

  const parsed = parseZaiQuotaUsage(payload);
  if (parsed.windows.length === 0) {
    return null;
  }

  return {
    providerId: config.providerId,
    ...(parsed.planType && { planType: parsed.planType }),
    windows: parsed.windows,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchZaiUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  return fetchZaiFamilyUsage(options, {
    providerId: 'zai',
    apiKeyEnvNames: ['ZAI_API_KEY'],
    regionEnvNames: ['ZAI_REGION'],
  });
}

export async function fetchZaiCodingPlanUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  return fetchZaiFamilyUsage(options, {
    providerId: 'zai-coding-plan',
    apiKeyEnvNames: ['ZAI_CODING_PLAN_API_KEY'],
    regionEnvNames: ['ZAI_CODING_PLAN_REGION'],
  });
}

// --- Aggregate ------------------------------------------------------------

/**
 * Fetch usage for every configured subscription provider. Providers that are
 * not connected, fail to respond, or return an unrecognized payload are
 * omitted rather than surfaced as errors.
 */
export async function getSubscriptionProviderUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage[]> {
  const results = await Promise.allSettled([
    fetchChatGptUsage(options),
    fetchGitHubCopilotUsage(options),
    fetchKimiForCodingUsage(options),
    fetchZaiUsage(options),
    fetchZaiCodingPlanUsage(options),
  ]);

  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value !== null
      ? [result.value]
      : [],
  );
}

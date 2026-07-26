import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_USAGE_ENDPOINT,
  GITHUB_COPILOT_USAGE_ENDPOINT,
  KIMI_FOR_CODING_USAGE_ENDPOINTS,
  XAI_USAGE_BILLING_ENDPOINT,
  XAI_USAGE_USER_ENDPOINT,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { getFreshChatGptAccessToken } from './chatgpt-subscription';
import { getGitHubCopilotAccessToken } from './github-copilot-subscription';
import { resolveModelProviderEnvValue } from './model-runtime-config';
import { getFreshXaiAccessToken } from './xai-subscription';

/**
 * Server-side usage/quota lookups for subscription-style inference providers,
 * using the same credentials the inference gateway already holds. All three
 * upstream endpoints are undocumented (each is what the provider's own CLI
 * polls), so every fetcher parses defensively and resolves to `null` on any
 * failure — the settings UI omits the usage line rather than erroring.
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

// --- xAI Grok subscription ------------------------------------------------

/**
 * Parse the unofficial Grok billing payload. Shape is not documented; accept
 * included-usage percent, credit totals, and reset times when present.
 * Exported for unit tests.
 */
export function parseXaiSubscriptionUsage(
  payload: unknown,
  now: number = Date.now(),
): SubscriptionUsageWindow[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const included = asRecord(
    root.included_usage ?? root.includedUsage ?? root.included,
  );
  const credits = asRecord(root.credits ?? root.credit);
  const onDemand = asRecord(root.on_demand ?? root.onDemand ?? root.ondemand);

  const windows: SubscriptionUsageWindow[] = [];

  const includedPercent =
    firstNumber(included, [
      'used_percent',
      'usedPercent',
      'percent_used',
      'percentUsed',
    ]) ??
    firstNumber(root, [
      'used_percent',
      'usedPercent',
      'included_used_percent',
      'includedUsedPercent',
    ]);

  const includedLimit = firstNumber(included, [
    'limit',
    'allowance',
    'total',
    'entitlement',
  ]);
  const includedRemaining = firstNumber(included, [
    'remaining',
    'remaining_credits',
    'remainingCredits',
  ]);
  const includedUsed = firstNumber(included, ['used', 'consumed']);
  const includedResetsAt =
    toResetIso(
      included?.['resets_at'] ??
        included?.['reset_at'] ??
        included?.['resetTime'] ??
        root['resets_at'] ??
        root['reset_at'],
    ) ??
    resetFromRelativeSeconds(
      firstNumber(included, ['reset_in', 'resets_in_seconds']) ??
        firstNumber(root, ['reset_in', 'resets_in_seconds']),
      now,
    );

  if (
    includedPercent !== undefined ||
    includedLimit !== undefined ||
    includedRemaining !== undefined ||
    includedUsed !== undefined
  ) {
    windows.push({
      label: 'Included usage',
      ...(includedPercent !== undefined && {
        usedPercent: clampPercent(includedPercent),
      }),
      ...(includedUsed !== undefined && { used: includedUsed }),
      ...(includedRemaining !== undefined && { remaining: includedRemaining }),
      ...(includedLimit !== undefined && { limit: includedLimit }),
      ...(includedResetsAt && { resetsAt: includedResetsAt }),
    });
  }

  const creditBalance = firstNumber(credits, [
    'balance',
    'remaining',
    'available',
    'prepaid_balance',
    'prepaidBalance',
  ]);
  if (creditBalance !== undefined) {
    windows.push({
      label: 'Credits',
      remaining: creditBalance,
    });
  }

  const onDemandUsed = firstNumber(onDemand, ['used', 'consumed']);
  const onDemandLimit = firstNumber(onDemand, ['limit', 'cap', 'allowance']);
  if (onDemandUsed !== undefined || onDemandLimit !== undefined) {
    windows.push({
      label: 'On-demand',
      ...(onDemandUsed !== undefined && { used: onDemandUsed }),
      ...(onDemandLimit !== undefined && { limit: onDemandLimit }),
      ...(onDemandUsed !== undefined &&
        onDemandLimit !== undefined &&
        onDemandLimit > 0 && {
          usedPercent: clampPercent((onDemandUsed / onDemandLimit) * 100),
        }),
    });
  }

  return windows;
}

export async function fetchXaiSubscriptionUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getFreshXaiAccessToken({
    ...(options.executor && { executor: options.executor }),
    fetchImpl,
  });

  if (!token) {
    return null;
  }

  const authHeaders = {
    authorization: `Bearer ${token.access}`,
    accept: 'application/json',
    'user-agent': 'roomote',
  };

  // Identity-first: resolve user, then request billing for that session.
  // Fail closed without surfacing identity or raw bodies to callers.
  const userResult = await fetchJson(
    fetchImpl,
    XAI_USAGE_USER_ENDPOINT,
    authHeaders,
  );
  if (userResult.status !== 200 || !asRecord(userResult.payload)?.userId) {
    // Some deployments return `id` instead of `userId`.
    const user = asRecord(userResult.payload);
    if (
      userResult.status !== 200 ||
      (!firstString(user, ['userId', 'user_id', 'id']) &&
        !firstNumber(user, ['userId', 'id']))
    ) {
      return null;
    }
  }

  const billingResult = await fetchJson(
    fetchImpl,
    XAI_USAGE_BILLING_ENDPOINT,
    authHeaders,
  );
  const windows = parseXaiSubscriptionUsage(billingResult.payload, Date.now());

  if (windows.length === 0) {
    return null;
  }

  return {
    providerId: 'xai-subscription',
    windows,
    fetchedAt: new Date().toISOString(),
  };
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
    fetchXaiSubscriptionUsage(options),
  ]);

  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value !== null
      ? [result.value]
      : [],
  );
}

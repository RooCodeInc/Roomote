import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_USAGE_ENDPOINT,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { getFreshChatGptAccessToken } from '../chatgpt-subscription';
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

function parseWindow(
  window: Record<string, unknown> | undefined,
  fallbackLabel: string,
  now: number,
): SubscriptionUsageWindow | undefined {
  if (!window) return undefined;
  let usedPercent = firstNumber(window, ['used_percent', 'usedPercent']);
  if (usedPercent === undefined) {
    const remaining = firstNumber(window, [
      'percent_left',
      'remaining_percent',
    ]);
    if (remaining !== undefined) usedPercent = 100 - remaining;
  }
  if (usedPercent === undefined) return undefined;
  const seconds = firstNumber(window, [
    'limit_window_seconds',
    'window_seconds',
  ]);
  const minutes =
    firstNumber(window, [
      'window_minutes',
      'window_duration_mins',
      'windowDurationMins',
    ]) ?? (seconds !== undefined ? seconds / 60 : undefined);
  const resetsAt =
    toResetIso(window.resets_at ?? window.reset_at) ??
    resetFromRelativeSeconds(
      firstNumber(window, ['resets_in_seconds', 'reset_after_seconds']),
      now,
    );
  return {
    label: formatWindowLabel(minutes) ?? fallbackLabel,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt && { resetsAt }),
  };
}

function parseChatGptUsage(
  payload: unknown,
  now: number,
): { planType?: string; windows: SubscriptionUsageWindow[] } {
  const root = asRecord(payload);
  if (!root) return { windows: [] };
  const raw = root.rate_limits ?? root.rateLimits ?? root.rate_limit;
  const limits = Array.isArray(raw)
    ? asRecord(
        raw.find((entry) => asRecord(entry)?.limit_id === 'codex') ?? raw[0],
      )
    : asRecord(raw);
  const windows = [
    parseWindow(
      asRecord(limits?.primary ?? limits?.primary_window ?? limits?.five_hour),
      '5h limit',
      now,
    ),
    parseWindow(
      asRecord(limits?.secondary ?? limits?.secondary_window ?? limits?.weekly),
      'Weekly limit',
      now,
    ),
  ].filter((window): window is SubscriptionUsageWindow => window !== undefined);
  const planType = firstString(root, ['plan_type', 'planType']);
  return { ...(planType && { planType }), windows };
}

export async function fetchChatGptUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fresh = await getFreshChatGptAccessToken({
    ...(options.executor && { executor: options.executor }),
    fetchImpl,
  });
  if (!fresh) return null;
  const { payload } = await fetchJson(fetchImpl, CHATGPT_USAGE_ENDPOINT, {
    authorization: `Bearer ${fresh.access}`,
    accept: 'application/json',
    'user-agent': 'roomote',
    origin: 'https://chatgpt.com',
    ...(fresh.accountId && { [CHATGPT_ACCOUNT_ID_HEADER]: fresh.accountId }),
  });
  const { planType, windows } = parseChatGptUsage(payload, Date.now());
  return windows.length > 0
    ? {
        providerId: 'chatgpt',
        ...(planType && { planType }),
        windows,
        fetchedAt: new Date().toISOString(),
      }
    : null;
}

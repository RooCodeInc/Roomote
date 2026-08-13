import {
  XAI_USAGE_BILLING_ENDPOINT,
  XAI_USAGE_CLI_IDENTITY_HEADERS,
  XAI_USAGE_USER_ENDPOINT,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { getFreshXaiAccessToken } from '../xai-subscription';
import {
  asRecord,
  clampPercent,
  fetchJson,
  firstNumber,
  firstString,
  resetFromRelativeSeconds,
  toResetIso,
  type UsageFetchOptions,
} from './shared';

function configFor(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload);
  return root && (asRecord(root.config) ?? root);
}

function resetsAt(
  config: Record<string, unknown>,
  now: number,
): string | undefined {
  const period = asRecord(config.currentPeriod ?? config.current_period);
  return (
    toResetIso(
      period?.end ??
        period?.ends_at ??
        period?.endsAt ??
        config.billingPeriodEnd ??
        config.billing_period_end ??
        config.resets_at ??
        config.reset_at,
    ) ??
    resetFromRelativeSeconds(
      firstNumber(config, ['reset_in', 'resets_in_seconds']),
      now,
    )
  );
}

export function parseXaiSubscriptionUsage(
  payload: unknown,
  now: number = Date.now(),
): SubscriptionUsageWindow[] {
  const root = asRecord(payload);
  const config = configFor(payload);
  if (!root || !config) return [];
  const windows: SubscriptionUsageWindow[] = [];
  const reset = resetsAt(config, now);
  const percent = firstNumber(config, [
    'creditUsagePercent',
    'credit_usage_percent',
    'used_percent',
    'usedPercent',
    'included_used_percent',
    'includedUsedPercent',
  ]);
  if (percent !== undefined)
    windows.push({
      label: 'Included usage',
      usedPercent: clampPercent(percent),
      ...(reset && { resetsAt: reset }),
    });
  const monthlyLimit = firstNumber(config, [
    'monthlyLimit',
    'monthly_limit',
    'limit',
    'allowance',
    'total',
    'entitlement',
  ]);
  const monthlyUsed = firstNumber(config, ['used', 'consumed', 'includedUsed']);
  if (
    windows.length === 0 &&
    (monthlyLimit !== undefined || monthlyUsed !== undefined)
  )
    windows.push({
      label: 'Included usage',
      ...(monthlyUsed !== undefined && { used: monthlyUsed }),
      ...(monthlyLimit !== undefined && { limit: monthlyLimit }),
      ...(monthlyUsed !== undefined &&
        monthlyLimit !== undefined &&
        monthlyLimit > 0 && {
          usedPercent: clampPercent((monthlyUsed / monthlyLimit) * 100),
        }),
      ...(reset && { resetsAt: reset }),
    });
  const included = asRecord(
    config.included_usage ??
      config.includedUsage ??
      config.included ??
      root.included_usage ??
      root.includedUsage ??
      root.included,
  );
  if (windows.length === 0 && included) {
    const includedPercent = firstNumber(included, [
      'used_percent',
      'usedPercent',
      'percent_used',
      'percentUsed',
    ]);
    const limit = firstNumber(included, [
      'limit',
      'allowance',
      'total',
      'entitlement',
    ]);
    const remaining = firstNumber(included, [
      'remaining',
      'remaining_credits',
      'remainingCredits',
    ]);
    const used = firstNumber(included, ['used', 'consumed']);
    const includedReset =
      toResetIso(
        included.resets_at ?? included.reset_at ?? included.resetTime,
      ) ?? reset;
    if (
      includedPercent !== undefined ||
      limit !== undefined ||
      remaining !== undefined ||
      used !== undefined
    )
      windows.push({
        label: 'Included usage',
        ...(includedPercent !== undefined && {
          usedPercent: clampPercent(includedPercent),
        }),
        ...(used !== undefined && { used }),
        ...(remaining !== undefined && { remaining }),
        ...(limit !== undefined && { limit }),
        ...(includedReset && { resetsAt: includedReset }),
      });
  }
  const credits = asRecord(config.credits ?? config.credit ?? root.credits);
  const balance =
    firstNumber(credits, [
      'balance',
      'remaining',
      'available',
      'prepaid_balance',
      'prepaidBalance',
    ]) ??
    firstNumber(config, ['prepaidBalance', 'prepaid_balance', 'creditBalance']);
  if (balance !== undefined && balance > 0)
    windows.push({ label: 'Credits', remaining: balance });
  const onDemand = asRecord(
    config.on_demand ??
      config.onDemand ??
      config.ondemand ??
      root.on_demand ??
      root.onDemand,
  );
  const used =
    firstNumber(onDemand, ['used', 'consumed']) ??
    firstNumber(config, ['onDemandUsed', 'on_demand_used']);
  const limit =
    firstNumber(onDemand, ['limit', 'cap', 'allowance']) ??
    firstNumber(config, ['onDemandCap', 'on_demand_cap']);
  if ((used !== undefined && used > 0) || (limit !== undefined && limit > 0))
    windows.push({
      label: 'On-demand',
      ...(used !== undefined && { used }),
      ...(limit !== undefined && { limit }),
      ...(used !== undefined &&
        limit !== undefined &&
        limit > 0 && { usedPercent: clampPercent((used / limit) * 100) }),
    });
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
  if (!token) return null;
  const headers = {
    authorization: `Bearer ${token.access}`,
    accept: 'application/json',
    'user-agent': 'roomote',
  };
  const user = await fetchJson(fetchImpl, XAI_USAGE_USER_ENDPOINT, headers);
  const identity = asRecord(user.payload);
  const userId =
    firstString(identity, ['userId', 'user_id', 'id']) ??
    firstNumber(identity, ['userId', 'id'])?.toString();
  if (user.status !== 200 || !userId) return null;
  const billing = await fetchJson(fetchImpl, XAI_USAGE_BILLING_ENDPOINT, {
    ...headers,
    ...XAI_USAGE_CLI_IDENTITY_HEADERS,
    'x-userid': userId,
  });
  const windows = parseXaiSubscriptionUsage(billing.payload, Date.now());
  return windows.length > 0
    ? {
        providerId: 'xai-subscription',
        windows,
        fetchedAt: new Date().toISOString(),
      }
    : null;
}

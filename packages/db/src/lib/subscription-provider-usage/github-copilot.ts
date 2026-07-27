import {
  GITHUB_COPILOT_USAGE_ENDPOINT,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { getGitHubCopilotAccessToken } from '../github-copilot-subscription';
import {
  clampPercent,
  fetchJson,
  firstNumber,
  firstString,
  toResetIso,
  asRecord,
  type UsageFetchOptions,
} from './shared';

function parseGitHubCopilotUsage(payload: unknown): SubscriptionUsageWindow[] {
  const root = asRecord(payload);
  const premium = asRecord(
    asRecord(root?.quota_snapshots)?.premium_interactions,
  );
  if (!premium) return [];

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
  if (!unlimited && usedPercent === undefined && remaining === undefined)
    return [];

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
  const token = await getGitHubCopilotAccessToken(options.executor);
  if (!token) return null;
  const { payload } = await fetchJson(
    options.fetchImpl ?? fetch,
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
  return windows.length > 0
    ? {
        providerId: 'github-copilot',
        windows,
        fetchedAt: new Date().toISOString(),
      }
    : null;
}

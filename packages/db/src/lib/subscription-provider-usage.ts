import { type SubscriptionProviderUsage } from '@roomote/types';

import { fetchChatGptUsage } from './subscription-provider-usage/chatgpt';
import { fetchGitHubCopilotUsage } from './subscription-provider-usage/github-copilot';
import { fetchKimiForCodingUsage } from './subscription-provider-usage/kimi';
import { type UsageFetchOptions } from './subscription-provider-usage/shared';
import {
  fetchXaiSubscriptionUsage,
  parseXaiSubscriptionUsage,
} from './subscription-provider-usage/xai';
import {
  fetchZaiCodingPlanUsage,
  fetchZaiUsage,
  parseZaiQuotaUsage,
} from './subscription-provider-usage/zai';

export {
  fetchChatGptUsage,
  fetchGitHubCopilotUsage,
  fetchKimiForCodingUsage,
  fetchXaiSubscriptionUsage,
  fetchZaiCodingPlanUsage,
  fetchZaiUsage,
  parseXaiSubscriptionUsage,
  parseZaiQuotaUsage,
};

const usageProviders = [
  fetchChatGptUsage,
  fetchGitHubCopilotUsage,
  fetchKimiForCodingUsage,
  fetchXaiSubscriptionUsage,
  fetchZaiUsage,
  fetchZaiCodingPlanUsage,
] as const;

/** Fetch usage from every configured provider, omitting unavailable responses. */
export async function getSubscriptionProviderUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage[]> {
  const results = await Promise.allSettled(
    usageProviders.map((fetchUsage) => fetchUsage(options)),
  );
  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value !== null
      ? [result.value]
      : [],
  );
}

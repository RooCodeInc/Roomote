import { getSubscriptionProviderUsage } from '@roomote/db/server';
import type { SubscriptionProviderUsage } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) throw new Error('Unauthorized');
}

/**
 * Usage/quota for connected subscription providers (ChatGPT, GitHub Copilot,
 * Kimi for Coding, OpenCode Go, xAI Grok subscription, Z.AI / Z.AI Coding
 * Plan).
 * Providers without a configured
 * credential or whose usage endpoint is unavailable are simply absent from
 * the result.
 */
export async function getSubscriptionProviderUsageCommand(
  auth: UserAuthSuccess,
): Promise<SubscriptionProviderUsage[]> {
  assertAdmin(auth);
  return getSubscriptionProviderUsage();
}

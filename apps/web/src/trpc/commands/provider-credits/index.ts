import { getProviderCreditBalances } from '@roomote/db/server';
import type { ProviderCreditBalance } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) throw new Error('Unauthorized');
}

/**
 * Credit remaining for connected API-key providers that expose a
 * key-readable balance endpoint (currently OpenRouter). Providers without a
 * configured credential or whose endpoint is unavailable are absent.
 */
export async function getProviderCreditBalancesCommand(
  auth: UserAuthSuccess,
): Promise<ProviderCreditBalance[]> {
  assertAdmin(auth);
  return getProviderCreditBalances();
}

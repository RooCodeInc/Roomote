/**
 * Normalized credit/spend remaining data for API-key inference providers that
 * expose a key-readable balance endpoint (currently OpenRouter), displayed on
 * the Models settings page under the connected provider row.
 *
 * Missing balance is a non-error: the UI simply omits the balance line.
 */

/** Setup-catalog provider ids that report credit balance. */
export type ProviderCreditBalanceProviderId = 'openrouter';

export interface ProviderCreditBalance {
  providerId: ProviderCreditBalanceProviderId;
  /**
   * Remaining spend when the provider reports it. For OpenRouter this is the
   * per-key credit cap remaining (`limit_remaining`), not necessarily the
   * full account wallet.
   */
  remaining?: number;
  /** Optional hard cap the remaining figure is measured against. */
  limit?: number;
  /** All-time usage when surfaced without a remaining figure. */
  usage?: number;
  currency?: string;
  /**
   * When true, the key has no per-key spend cap. UI should omit a remaining
   * line rather than claim a wallet balance.
   */
  unlimited?: boolean;
  fetchedAt: string;
}

/**
 * OpenRouter documents this as the endpoint for credit remaining on the
 * current API key (`data.limit_remaining` / `data.limit`).
 * https://openrouter.ai/docs/api_reference/limits
 */
export const OPENROUTER_KEY_ENDPOINT =
  'https://openrouter.ai/api/v1/key' as const;

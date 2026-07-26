/**
 * Normalized usage/quota data for subscription-style inference providers
 * (ChatGPT subscription, GitHub Copilot, Kimi for Coding), displayed in the
 * Models settings page.
 *
 * None of the upstream usage endpoints below are officially documented; each
 * is the endpoint the provider's own CLI or editor plugin polls for its usage
 * display. Their payload shapes have shifted before, so parsers must stay
 * tolerant and callers must treat missing usage as a non-error (the UI simply
 * omits the usage line).
 */

/** Setup-catalog provider ids that report subscription usage. */
export type SubscriptionUsageProviderId =
  | 'chatgpt'
  | 'github-copilot'
  | 'kimi-for-coding'
  | 'xai-subscription';

/**
 * One quota window, e.g. Copilot's monthly premium requests or the Codex
 * 5-hour/weekly rate-limit windows. Providers report different subsets of
 * these fields; the UI renders whatever is present.
 */
export interface SubscriptionUsageWindow {
  /** Short display label, e.g. '5h limit', 'Weekly limit', 'Premium requests'. */
  label: string;
  /** Percent of the window consumed, 0-100. */
  usedPercent?: number;
  used?: number;
  remaining?: number;
  limit?: number;
  unlimited?: boolean;
  /** ISO timestamp when the window resets. */
  resetsAt?: string;
}

export interface SubscriptionProviderUsage {
  providerId: SubscriptionUsageProviderId;
  /** Provider-reported plan name (e.g. ChatGPT 'plus'/'pro'), when available. */
  planType?: string;
  windows: SubscriptionUsageWindow[];
  fetchedAt: string;
}

/**
 * Internal GitHub endpoint whose `quota_snapshots` field carries the live
 * premium-request quota; the official billing API only reports lagging
 * consumption. Same endpoint Copilot editor integrations poll.
 */
export const GITHUB_COPILOT_USAGE_ENDPOINT =
  'https://api.github.com/copilot_internal/user';

/** ChatGPT backend endpoint Codex CLI polls for its /status rate-limit view. */
export const CHATGPT_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage';

/**
 * Kimi Code (Coding Plan) usage endpoints, as polled by Kimi CLI's /usage
 * command. Newer deployments serve /v1/usages; older ones only /v1/usage, so
 * callers try each in order and fall through on 404.
 */
export const KIMI_FOR_CODING_USAGE_ENDPOINTS = [
  'https://api.kimi.com/coding/v1/usages',
  'https://api.kimi.com/coding/v1/usage',
] as const;

/**
 * Unofficial Grok CLI session proxy used for SuperGrok / Premium+ billing
 * lookups (same surface Grok Build and peer OAuth tools poll). Not a stable
 * public API; parse defensively and omit usage on failure.
 */
export const XAI_CLI_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com';
export const XAI_USAGE_USER_ENDPOINT = `${XAI_CLI_CHAT_PROXY_BASE_URL}/v1/user`;
export const XAI_USAGE_BILLING_ENDPOINT = `${XAI_CLI_CHAT_PROXY_BASE_URL}/v1/billing?format=credits`;

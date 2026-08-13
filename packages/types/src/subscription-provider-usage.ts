/**
 * Normalized usage/quota data for subscription-style inference providers
 * (ChatGPT subscription, GitHub Copilot, Kimi for Coding, OpenCode Go, Z.AI
 * quotas),
 * displayed in the Models settings page.
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
  | 'opencode-go'
  | 'xai-subscription'
  | 'zai'
  | 'zai-coding-plan';

/**
 * Subscription-usage providers that share the generic API-key connected row
 * (not dedicated OAuth rows like ChatGPT / Copilot). Keep the Settings
 * allowlist in sync with this set.
 */
export const API_KEY_SUBSCRIPTION_USAGE_PROVIDER_IDS = [
  'kimi-for-coding',
  'opencode-go',
  'zai',
  'zai-coding-plan',
] as const satisfies readonly SubscriptionUsageProviderId[];

export type ApiKeySubscriptionUsageProviderId =
  (typeof API_KEY_SUBSCRIPTION_USAGE_PROVIDER_IDS)[number];

export function isApiKeySubscriptionUsageProviderId(
  providerId: string,
): providerId is ApiKeySubscriptionUsageProviderId {
  return (
    API_KEY_SUBSCRIPTION_USAGE_PROVIDER_IDS as readonly string[]
  ).includes(providerId);
}

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

/** OpenCode Go usage endpoint for rolling, weekly, and monthly quotas. */
export const OPENCODE_GO_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';

/**
 * Unofficial Grok CLI session proxy used for SuperGrok / Premium+ billing
 * lookups (same surface Grok Build and peer OAuth tools poll). Not a stable
 * public API; parse defensively and omit usage on failure.
 *
 * The proxy strips `creditUsagePercent` / `productUsage` unless the request
 * carries the Grok CLI identity fingerprint below. A bare Bearer request
 * still returns 200 with period metadata, so callers must send these
 * headers or the Settings usage bar silently disappears. Do not add
 * `x-grok-client-version`: a pinned version 426s once Grok CLI moves on.
 */
export const XAI_CLI_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com';
export const XAI_USAGE_USER_ENDPOINT = `${XAI_CLI_CHAT_PROXY_BASE_URL}/v1/user`;
export const XAI_USAGE_BILLING_ENDPOINT = `${XAI_CLI_CHAT_PROXY_BASE_URL}/v1/billing?format=credits`;
export const XAI_USAGE_CLI_IDENTITY_HEADERS = {
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-mode': 'billing',
} as const;

/**
 * Undocumented Z.AI / BigModel monitor quota endpoint polled by Coding Plan
 * tools and community usage bars. Host is region-specific; path is shared.
 * Global → api.z.ai; China → open.bigmodel.cn.
 */
export const ZAI_USAGE_QUOTA_PATH = '/api/monitor/usage/quota/limit' as const;
export const ZAI_USAGE_HOSTS = {
  global: 'https://api.z.ai',
  china: 'https://open.bigmodel.cn',
} as const;

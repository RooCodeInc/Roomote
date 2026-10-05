import { BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID } from './inference-gateway';
import {
  getDisplayModelProviderId,
  getModelProviderLabel,
} from './model-provider-config';

/**
 * Structured provider codes that mean the account has no credits or quota
 * left, as opposed to a rate limit that clears on its own:
 * - OpenAI API and the ChatGPT (Codex) backend: `insufficient_quota` (as
 *   `error.type` and `error.code`) and the spend-cap codes the Codex CLI
 *   treats as fatal; the subscription's `usage_limit_reached` window and
 *   `usage_not_included` plan, both sent as HTTP 429.
 * - Anthropic: the 402 `billing_error` type and the monthly spend cap's
 *   `error.details.error_code`, sent as a 429 `rate_limit_error`.
 * - OpenRouter: the typed 402 `error_type`.
 */
const CREDITS_EXHAUSTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'usage_limit_reached',
  'usage_not_included',
  'billing_error',
  'enforced_spend_limit_reached',
  'payment_required',
]);

const CREDITS_EXHAUSTED_CODE_KEYS = [
  'type',
  'code',
  'error_type',
  'error_code',
] as const;

// OpenRouter names the exhausted limit on every 402. Its in-flight spending
// budget is a hold on estimated cost that clears as requests settle, sent
// with Retry-After; that one is temporary, not an empty account.
const OPENROUTER_EXHAUSTED_LIMIT_SOURCES: ReadonlySet<string> = new Set([
  'openrouter_credits',
  'openrouter_key_limit',
]);
const OPENROUTER_IN_FLIGHT_LIMIT_SOURCE = 'openrouter_in_flight_budget';
const OPENROUTER_IN_FLIGHT_REASON = 'in_flight_budget_exhausted';

/**
 * Provider wording for the same failures, for paths that only carry text:
 * OpenCode's retry status reports just the message, and a JSON body OpenCode
 * could not parse is appended to its message as raw text. Each pattern is a
 * provider's own phrasing; generic words such as "quota" or "billing" are
 * deliberately absent because rate limits use them too.
 */
const CREDITS_EXHAUSTED_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:insufficient_quota|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|usage_limit_reached|usage_not_included|enforced_spend_limit_reached)\b/u,
  // ChatGPT subscription.
  /\bthe usage limit has been reached\b/u,
  // OpenAI API. Gemini reuses the first sentence for its per-minute rate
  // limits, so only OpenAI's own documentation link makes it conclusive.
  /\byou exceeded your current quota\b[\s\S]*\bplatform\.openai\.com\b/u,
  // OpenCode's rewrites of streamed `insufficient_quota` and
  // `usage_not_included` errors.
  /\bquota exceeded\. check your plan and billing details\b/u,
  /\bto use codex with your chatgpt plan\b/u,
  // Anthropic prepaid credits and spend limits.
  /\byour credit balance is too low\b/u,
  /\byou have reached your (?:specified )?(?:workspace )?api usage limits\b/u,
  // OpenRouter.
  /\brequires more credits\b/u,
  /\binsufficient credits\b/u,
  // Roomote inference gateway.
  /\broomote inference credits are exhausted\b/u,
];

// Values that echo the request rather than describe the failure. A prompt
// that mentions credits must never read as a provider verdict.
const IGNORED_ERROR_KEYS: ReadonlySet<string> = new Set([
  'headers',
  'input',
  'messages',
  'parts',
  'prompt',
  'request',
  'requestBody',
  'requestBodyValues',
  'responseHeaders',
  'system',
  'tools',
]);

// Provider bodies sit several levels down: OpenCode error -> data ->
// responseBody (JSON text) -> error -> metadata or details.
const MAX_ERROR_DEPTH = 8;
const MAX_ERROR_VALUES = 256;
const MAX_ERROR_TEXT_CHARS = 16_384;

function collectErrorValues(error: unknown): {
  records: Record<string, unknown>[];
  texts: string[];
} {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  const records: Record<string, unknown>[] = [];
  const texts: string[] = [];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_ERROR_VALUES) {
    const { value, depth } = pending.shift()!;
    visited += 1;

    if (typeof value === 'string') {
      texts.push(value);
      const trimmed = value.trim();
      if (
        depth < MAX_ERROR_DEPTH &&
        (trimmed.startsWith('{') || trimmed.startsWith('['))
      ) {
        try {
          pending.push({ value: JSON.parse(trimmed), depth: depth + 1 });
        } catch {
          // Prose that only looks like JSON is still checked as text.
        }
      }
      continue;
    }

    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (depth >= MAX_ERROR_DEPTH) continue;

    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }

    const record = value as Record<string, unknown>;
    records.push(record);
    // Error instances keep their message and cause off the enumerable
    // surface that Object.entries walks.
    if (value instanceof Error) {
      pending.push({ value: value.message, depth: depth + 1 });
      if (value.cause !== undefined) {
        pending.push({ value: value.cause, depth: depth + 1 });
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      if (!IGNORED_ERROR_KEYS.has(key)) {
        pending.push({ value: nested, depth: depth + 1 });
      }
    }
  }

  return { records, texts };
}

function parseHttpErrorStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{3}$/u.test(value.trim())
        ? Number(value.trim())
        : undefined;

  return parsed !== undefined &&
    Number.isInteger(parsed) &&
    parsed >= 400 &&
    parsed <= 599
    ? parsed
    : undefined;
}

/** The outermost HTTP error status, as `statusCode`, `status`, or `code`. */
function findHttpErrorStatus(
  records: Record<string, unknown>[],
): number | undefined {
  for (const record of records) {
    for (const key of ['statusCode', 'status', 'code'] as const) {
      const status = parseHttpErrorStatus(record[key]);
      if (status !== undefined) return status;
    }
  }

  return undefined;
}

function normalizeCode(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function isOpenRouterInFlightBudget(record: Record<string, unknown>): boolean {
  return (
    normalizeCode(record.limit_source) === OPENROUTER_IN_FLIGHT_LIMIT_SOURCE ||
    normalizeCode(record.reason) === OPENROUTER_IN_FLIGHT_REASON
  );
}

/**
 * OpenRouter's in-flight spending budget: a 402 that holds the estimated cost
 * of recent requests while they settle, sent with Retry-After. It clears on
 * its own, so it must never read as an empty account.
 */
export function isOpenRouterInFlightBudgetError(error: unknown): boolean {
  return collectErrorValues(error).records.some(isOpenRouterInFlightBudget);
}

function hasCreditsExhaustedCode(record: Record<string, unknown>): boolean {
  const limitSource = normalizeCode(record.limit_source);
  if (limitSource && OPENROUTER_EXHAUSTED_LIMIT_SOURCES.has(limitSource)) {
    return true;
  }

  return CREDITS_EXHAUSTED_CODE_KEYS.some((key) => {
    const code = normalizeCode(record[key]);
    return code !== undefined && CREDITS_EXHAUSTED_ERROR_CODES.has(code);
  });
}

/**
 * Whether an inference error says the provider account ran out of credits or
 * quota: HTTP 402, a provider's structured credit/quota code, or a provider's
 * own wording for it. Retrying cannot recover these until someone tops up the
 * account or picks another provider, so callers stop retrying.
 *
 * A plain rate limit (429 without a credit/quota code or message) is never a
 * match, and neither is OpenRouter's temporary in-flight budget 402.
 */
export function isInferenceCreditsExhaustedError(error: unknown): boolean {
  const { records, texts } = collectErrorValues(error);

  if (records.some(isOpenRouterInFlightBudget)) return false;
  if (findHttpErrorStatus(records) === 402) return true;
  if (records.some(hasCreditsExhaustedCode)) return true;

  return texts.some((text) => {
    const normalized = text.slice(0, MAX_ERROR_TEXT_CHARS).toLowerCase();
    return CREDITS_EXHAUSTED_TEXT_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    );
  });
}

/**
 * Display name of the provider that serves a model id, for user-facing
 * messages. `openai/` models run on the ChatGPT subscription whenever one is
 * connected, so callers pass that connection state.
 */
export function resolveInferenceProviderDisplayName(
  modelId: string | null | undefined,
  options: {
    chatgptConnected?: boolean;
    xaiSubscriptionConnected?: boolean;
  } = {},
): string | undefined {
  const providerId = getDisplayModelProviderId(modelId, options);

  if (!providerId) return undefined;

  return getModelProviderLabel(
    providerId === BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID
      ? 'amazon-bedrock'
      : providerId,
  );
}

export function formatInferenceCreditsExhaustedMessage(
  providerName?: string | null,
): string {
  const provider = providerName?.trim() || 'the inference provider';

  return `You seem to have run out of credits for ${provider}. Choose another provider/model or reset your subscription to continue.`;
}

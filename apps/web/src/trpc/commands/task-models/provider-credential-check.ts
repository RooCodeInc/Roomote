import {
  getInferenceGatewayProvider,
  type SetupModelProviderDescriptor,
  type SetupModelProviderId,
} from '@roomote/types';

import { getPersistedEnvironmentVariableValues } from '../environment-variables';

/**
 * Saves block on this check, so keep it short enough that a wedged network
 * does not look like a hung form.
 */
const SAVE_VALIDATION_TIMEOUT_MS = 8_000;

const PROVIDER_MESSAGE_MAX_CHARS = 240;

/** Statuses every provider uses to say "this credential is not valid". */
const DEFAULT_REJECTION_STATUSES: readonly number[] = [401, 403];

type ModelProviderKeyProbe = {
  /**
   * Path appended to the provider's upstream API base. Must be an endpoint
   * that requires the API key: a route the provider serves unauthenticated
   * (OpenRouter's `/v1/models`, for one) would accept any string as valid.
   */
  path: string;
  /** Headers the endpoint needs beyond the provider's auth header. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Statuses this provider uses to reject a credential beyond 401/403. Only
   * for providers that answer a well-formed request with something else;
   * anything not listed stays "could not verify" and never blocks a save.
   */
  rejectionStatuses?: readonly number[];
};

/**
 * Hosted API-key providers Roomote authenticates before saving the key, keyed
 * by catalog id. Each probe is a cheap authenticated GET against the same
 * upstream base the inference gateway forwards to, so the endpoints stay in
 * one place as the catalog grows.
 *
 * Deliberately partial. Providers that resolve an operator-supplied endpoint
 * (`litellm`, `ollama`, `vllm`, `openai-compatible`), OAuth providers
 * (`github-copilot`, `chatgpt`), and providers whose credential is not a
 * single bearer-style key (Bedrock, Azure) keep their existing behavior;
 * adding one here is a table entry, not a code change.
 */
const MODEL_PROVIDER_KEY_PROBES = {
  anthropic: {
    path: '/v1/models?limit=1',
    headers: { 'anthropic-version': '2023-06-01' },
  },
  openai: { path: '/v1/models' },
  // Google and xAI answer an unusable key with 400, not 401. Each probe is a
  // fixed GET with no body, so a 400 there is about the key, not the request.
  google: { path: '/v1beta/models', rejectionStatuses: [400] },
  xai: { path: '/v1/models', rejectionStatuses: [400] },
  moonshotai: { path: '/v1/models' },
  // `/api/v1/models` is public on OpenRouter; `/api/v1/key` is the key check.
  openrouter: { path: '/v1/key' },
  togetherai: { path: '/v1/models' },
} as const satisfies Partial<
  Record<SetupModelProviderId, ModelProviderKeyProbe>
>;

type ModelProviderKeyValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  /** Roomote could not get an answer. Not a verdict on the key. */
  | { status: 'unknown'; error: string };

type ModelProviderKeyProbeTarget = {
  url: string;
  headers: Record<string, string>;
  rejectionStatuses: readonly number[];
};

function getModelProviderKeyProbe(
  providerId: string,
): ModelProviderKeyProbe | null {
  return (
    (
      MODEL_PROVIDER_KEY_PROBES as Partial<
        Record<string, ModelProviderKeyProbe>
      >
    )[providerId] ?? null
  );
}

/**
 * Build the probe request from the provider's inference-gateway descriptor:
 * the upstream base URL and the auth header shape the gateway already uses to
 * reach that provider. Templated bases (`{region}`, `{resource}`) resolve
 * per-request at the gateway and have no single save-time value, so a provider
 * carrying one is left unvalidated rather than guessed at.
 */
function buildModelProviderKeyProbeTarget({
  providerId,
  apiKey,
}: {
  providerId: string;
  apiKey: string;
}): ModelProviderKeyProbeTarget | null {
  const probe = getModelProviderKeyProbe(providerId);
  const gateway = getInferenceGatewayProvider(providerId);
  const baseUrl = gateway?.upstreamBaseUrl;
  const authHeader = gateway?.authHeader;

  if (!probe || !baseUrl || !authHeader || baseUrl.includes('{')) {
    return null;
  }

  return {
    url: `${baseUrl.replace(/\/+$/u, '')}${probe.path}`,
    headers: {
      Accept: 'application/json',
      [authHeader.name]:
        authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey,
      ...probe.headers,
    },
    rejectionStatuses: probe.rejectionStatuses
      ? [...DEFAULT_REJECTION_STATUSES, ...probe.rejectionStatuses]
      : DEFAULT_REJECTION_STATUSES,
  };
}

/** True when Roomote can authenticate this provider's key before saving it. */
export function canValidateModelProviderApiKey(providerId: string): boolean {
  return getModelProviderKeyProbe(providerId) !== null;
}

/**
 * Providers answer rejections with their own JSON shapes. Take the first
 * message-bearing field and clip it: the operator needs the provider's own
 * words, not its whole error envelope.
 */
function readProviderErrorMessage(body: string): string | null {
  let message: unknown = null;

  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as { error?: unknown; message?: unknown };
      const error = envelope.error;

      message =
        typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null
            ? (error as { message?: unknown }).message
            : envelope.message;
    }
  } catch {
    // Gateways and proxies answer with HTML; there is nothing to quote.
    return null;
  }

  if (typeof message !== 'string') {
    return null;
  }

  const collapsed = message.trim().replace(/\s+/gu, ' ');

  if (!collapsed) {
    return null;
  }

  return collapsed.length > PROVIDER_MESSAGE_MAX_CHARS
    ? `${collapsed.slice(0, PROVIDER_MESSAGE_MAX_CHARS)}…`
    : collapsed;
}

function describeCredentialField(
  provider: SetupModelProviderDescriptor,
): string {
  const label = provider.envVarLabel ?? 'API key';

  return provider.envVarName ? `${label} (${provider.envVarName})` : label;
}

function buildRejectionMessage({
  provider,
  status,
  providerMessage,
}: {
  provider: SetupModelProviderDescriptor;
  status: number;
  providerMessage: string | null;
}): string {
  const quote = providerMessage ? `: “${providerMessage}”` : '.';

  return `${provider.label} rejected the ${describeCredentialField(
    provider,
  )}, status ${status}${quote} Check the value and save it again.`;
}

/**
 * Prove an API key authenticates by making the cheapest authenticated call the
 * provider offers. Returns `invalid` only when the provider itself rejected
 * the key; a timeout, an outage, or an unexpected status is `unknown`, so a
 * provider having a bad day never blocks a save.
 */
export async function validateModelProviderApiKey({
  provider,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = SAVE_VALIDATION_TIMEOUT_MS,
}: {
  provider: SetupModelProviderDescriptor;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelProviderKeyValidationResult> {
  const target = buildModelProviderKeyProbeTarget({
    providerId: provider.id,
    apiKey,
  });

  if (!target) {
    return { status: 'valid' };
  }

  let response: Response;

  try {
    response = await fetchImpl(target.url, {
      method: 'GET',
      headers: target.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: 'unknown',
      error: `Could not reach ${provider.label} to verify the ${describeCredentialField(
        provider,
      )}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (target.rejectionStatuses.includes(response.status)) {
    return {
      status: 'invalid',
      error: buildRejectionMessage({
        provider,
        status: response.status,
        providerMessage: readProviderErrorMessage(
          await response.text().catch(() => ''),
        ),
      }),
    };
  }

  if (!response.ok) {
    // Nothing here says the key is bad: rate limits, outages, and endpoints a
    // provider has moved all land in this branch.
    await response.body?.cancel().catch(() => {});

    return {
      status: 'unknown',
      error: `Could not verify the ${provider.label} ${describeCredentialField(
        provider,
      )}: ${provider.label} returned HTTP ${response.status}.`,
    };
  }

  await response.body?.cancel().catch(() => {});

  return { status: 'valid' };
}

/**
 * Resolve the key the save is about to produce, the way the connected/
 * satisfied checks resolve it: the submitted value, then a runtime env var,
 * then what is already stored.
 *
 * `||`, not `??`: the settings form submits an empty string for a field
 * already satisfied by a runtime env var, and `??` would keep that empty
 * string and skip the probe entirely.
 */
async function resolvePendingModelProviderApiKey(
  provider: SetupModelProviderDescriptor,
  submittedApiKey: string | undefined,
): Promise<string | null> {
  const { envVarName } = provider;

  if (!envVarName) {
    return null;
  }

  const submitted = submittedApiKey?.trim();

  if (submitted) {
    return submitted;
  }

  const runtime = process.env[envVarName]?.trim();

  if (runtime) {
    return runtime;
  }

  const persisted = await getPersistedEnvironmentVariableValues([envVarName]);

  return persisted[envVarName]?.trim() || null;
}

/**
 * Fail a model-provider save when the provider rejects the API key. Presence
 * of a non-empty value used to be enough to report the provider connected,
 * which left a typo or a revoked key to surface as a failed task run hours
 * later, attributed to Roomote rather than to the credential.
 */
export async function assertModelProviderApiKeyAuthenticates({
  provider,
  apiKey,
}: {
  provider: SetupModelProviderDescriptor;
  apiKey?: string;
}): Promise<void> {
  if (!canValidateModelProviderApiKey(provider.id)) {
    return;
  }

  const resolvedApiKey = await resolvePendingModelProviderApiKey(
    provider,
    apiKey,
  );

  if (!resolvedApiKey) {
    // The per-field required-value check reports a missing key with copy that
    // points at the empty field.
    return;
  }

  const result = await validateModelProviderApiKey({
    provider,
    apiKey: resolvedApiKey,
  });

  if (result.status === 'invalid') {
    throw new Error(result.error);
  }
}

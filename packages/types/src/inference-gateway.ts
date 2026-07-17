import type { SetupModelProviderId } from './model-provider-config';

/**
 * Sandbox-facing env var carrying the gateway base URL (e.g.
 * `https://api.example.com/api/inference`). Emitted by the control plane at
 * dequeue; its presence is what switches the worker's OpenCode config onto
 * the gateway.
 */
export const INFERENCE_GATEWAY_URL_ENV_VAR_NAME = 'R_INFERENCE_GATEWAY_URL';

/**
 * Sandbox-facing env var carrying the comma-separated provider key env-var
 * names the gateway is serving for this run (the configured, gateway-covered
 * keys withheld from the sandbox at dequeue). It is the single authoritative
 * signal the worker uses to (1) strip exactly those keys from the harness
 * env and (2) rebase exactly those providers onto the gateway, keeping the
 * withheld set and the rebased set identical.
 */
export const INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME = 'R_INFERENCE_GATEWAY_KEYS';

/**
 * OpenCode registers Bedrock models under this provider id (an
 * Anthropic-compatible endpoint), distinct from the `amazon-bedrock` setup
 * provider id.
 */
export const BEDROCK_MANTLE_OPENCODE_PROVIDER_ID = 'bedrock-mantle';

/** Matches valid cloud regions like `us-east-1`. */
export const INFERENCE_GATEWAY_REGION_PATTERN =
  /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u;

/** Default AWS region for the Bedrock Mantle Anthropic-compatible endpoint. */
export const DEFAULT_BEDROCK_MANTLE_REGION = 'us-east-1';

/**
 * Gateway path segment for the ChatGPT-subscription provider. Distinct from
 * the key-authenticated `openai` entry: the OpenCode provider id stays
 * `openai` (the model prefix), but its baseURL points at this segment so the
 * gateway can hold the OAuth record and rewrite to the Codex backend.
 */
export const CHATGPT_GATEWAY_PROVIDER_ID = 'openai-chatgpt';

/** The ChatGPT Codex backend the OpenCode Codex plugin targets. */
export const CHATGPT_CODEX_UPSTREAM_BASE_URL = 'https://chatgpt.com';
export const CHATGPT_CODEX_UPSTREAM_PATH = '/backend-api/codex/responses';

/** Account-scoping header the Codex backend requires alongside the bearer. */
export const CHATGPT_ACCOUNT_ID_HEADER = 'ChatGPT-Account-Id';

/**
 * Sandbox-facing marker set at dequeue when the gateway is serving a
 * connected ChatGPT subscription: the worker rebases the OpenCode `openai`
 * provider onto the gateway instead of materializing `OPENCODE_AUTH_CONTENT`,
 * so the subscription OAuth record never enters the sandbox.
 */
export const INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME =
  'R_INFERENCE_GATEWAY_CHATGPT';

interface InferenceGatewayAuthHeader {
  name: string;
  scheme?: 'bearer';
}

/**
 * How the gateway authenticates upstream for a provider:
 * - `api-key`: inject a static deployment key (the default).
 * - `chatgpt-oauth`: mint a fresh ChatGPT-subscription access token
 *   server-side and add the account-id header; the sandbox holds no key.
 */
export type InferenceGatewayAuthStrategy = 'api-key' | 'chatgpt-oauth';

export interface InferenceGatewayProvider {
  /**
   * Provider id, used as the gateway path segment. It also matches the
   * OpenCode provider id for key-authenticated providers; the
   * ChatGPT-subscription entry is the exception (its OpenCode id is `openai`).
   */
  id:
    | SetupModelProviderId
    | typeof BEDROCK_MANTLE_OPENCODE_PROVIDER_ID
    | typeof CHATGPT_GATEWAY_PROVIDER_ID;
  name: string;
  /**
   * Deployment env vars holding the provider API key the gateway injects,
   * in precedence order. Empty for non-key auth strategies.
   */
  envVarNames: readonly string[];
  /** How the gateway authenticates upstream. Defaults to `api-key`. */
  authStrategy?: InferenceGatewayAuthStrategy;
  /**
   * Upstream API base. May contain a `{region}` placeholder resolved
   * per-request from `region` below.
   */
  upstreamBaseUrl?: string;
  /** Deployment env var holding an operator-configured upstream base URL. */
  upstreamBaseUrlEnvVarName?: string;
  /**
   * When set, every allowed request path is rewritten to this fixed upstream
   * path (the ChatGPT Codex backend collapses `/responses` and
   * `/chat/completions` to a single endpoint).
   */
  collapseToPath?: string;
  /**
   * Region resolution for `{region}`-templated upstreams: the deployment env
   * var to read and the fallback when it is unset.
   */
  region?: { envVarName: string; default: string };
  /** How the upstream expects its API key when the gateway forwards. */
  authHeader?: InferenceGatewayAuthHeader;
  /** A configured upstream key is forwarded when present but is not required. */
  optionalApiKey?: boolean;
  /**
   * Upstream inference endpoints the gateway forwards, matched exactly.
   * Everything else is rejected so a run token can only reach inference
   * endpoints, never the provider's account, billing, or admin surface.
   */
  allowedPaths: readonly string[];
  /**
   * Also allow paths nested below each `allowedPaths` entry. Only for
   * upstreams whose route shape requires it (Google puts the model ID and
   * action below `/models`; Vercel's AI Gateway protocol lives below
   * `/v1/ai`) and whose API has no account surface under those prefixes.
   */
  allowNestedPaths?: boolean;
  /**
   * Base-path suffix the provider's SDK expects on a baseURL override,
   * mirroring the upstream default base path (the SDK appends endpoint paths
   * like `/messages` or `/chat/completions` below it).
   */
  openCodeBaseUrlSuffix: string;
}

/**
 * Inference endpoints for OpenAI-compatible upstreams
 * (`@ai-sdk/openai-compatible` and SDKs that share its route shape).
 */
const OPENAI_COMPATIBLE_INFERENCE_PATHS: readonly string[] = [
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/models',
];

/** Inference endpoints for Anthropic-compatible upstreams. */
const ANTHROPIC_COMPATIBLE_INFERENCE_PATHS: readonly string[] = [
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/models',
];

/**
 * Providers reachable through the inference gateway. Key-authenticated
 * HTTP-proxyable providers only. Google Vertex is disabled while its
 * service-account request signing cannot stay on the control plane; ChatGPT
 * subscription OAuth is handled by its dedicated gateway route. Upstream
 * bases follow models.dev, the registry OpenCode itself resolves providers
 * from.
 */
export const INFERENCE_GATEWAY_PROVIDERS: readonly InferenceGatewayProvider[] =
  [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      envVarNames: ['OPENROUTER_API_KEY'],
      upstreamBaseUrl: 'https://openrouter.ai/api',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      envVarNames: ['ANTHROPIC_API_KEY'],
      upstreamBaseUrl: 'https://api.anthropic.com',
      authHeader: { name: 'x-api-key' },
      allowedPaths: ANTHROPIC_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      envVarNames: ['OPENAI_API_KEY'],
      upstreamBaseUrl: 'https://api.openai.com',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: [
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/embeddings',
        '/v1/models',
      ],
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'google',
      name: 'Google Gemini',
      // GOOGLE_GENERATIVE_AI_API_KEY first: it is @ai-sdk/google's native env
      // var, so when both are set the pre-gateway sandbox used it. GEMINI_API_KEY
      // is Roomote's setup-catalog alias and the common single-key case.
      envVarNames: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
      upstreamBaseUrl: 'https://generativelanguage.googleapis.com',
      authHeader: { name: 'x-goog-api-key' },
      allowedPaths: ['/v1beta/models', '/v1/models'],
      allowNestedPaths: true,
      openCodeBaseUrlSuffix: '/v1beta',
    },
    {
      id: 'vercel',
      name: 'Vercel AI Gateway',
      envVarNames: ['AI_GATEWAY_API_KEY'],
      upstreamBaseUrl: 'https://ai-gateway.vercel.sh',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      // The @ai-sdk/gateway protocol (config, language-model, embedding-model)
      // lives below /v1/ai; the host serves inference only.
      allowedPaths: ['/v1/ai'],
      allowNestedPaths: true,
      openCodeBaseUrlSuffix: '/v1/ai',
    },
    {
      id: 'requesty',
      name: 'Requesty',
      envVarNames: ['REQUESTY_API_KEY'],
      upstreamBaseUrl: 'https://router.requesty.ai',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'baseten',
      name: 'Baseten',
      envVarNames: ['BASETEN_API_KEY'],
      upstreamBaseUrl: 'https://inference.baseten.co',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'togetherai',
      name: 'Together AI',
      envVarNames: ['TOGETHER_API_KEY'],
      upstreamBaseUrl: 'https://api.together.xyz',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'moonshotai',
      name: 'Moonshot AI',
      envVarNames: ['MOONSHOT_API_KEY'],
      upstreamBaseUrl: 'https://api.moonshot.ai',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      envVarNames: ['MINIMAX_API_KEY'],
      // models.dev registers MiniMax through its Anthropic-compatible
      // endpoint (@ai-sdk/anthropic with base /anthropic/v1).
      upstreamBaseUrl: 'https://api.minimax.io/anthropic',
      authHeader: { name: 'x-api-key' },
      allowedPaths: ANTHROPIC_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      envVarNames: ['OPENCODE_API_KEY'],
      upstreamBaseUrl: 'https://opencode.ai/zen',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'xai',
      name: 'xAI',
      envVarNames: ['XAI_API_KEY'],
      upstreamBaseUrl: 'https://api.x.ai',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: [
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/embeddings',
        '/v1/models',
      ],
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: BEDROCK_MANTLE_OPENCODE_PROVIDER_ID,
      name: 'Amazon Bedrock',
      envVarNames: ['AWS_BEARER_TOKEN_BEDROCK'],
      upstreamBaseUrl: 'https://bedrock-mantle.{region}.api.aws/anthropic',
      region: {
        envVarName: 'AWS_REGION',
        default: DEFAULT_BEDROCK_MANTLE_REGION,
      },
      authHeader: { name: 'x-api-key' },
      allowedPaths: ANTHROPIC_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'litellm',
      name: 'LiteLLM',
      envVarNames: ['LITELLM_API_KEY'],
      upstreamBaseUrlEnvVarName: 'LITELLM_BASE_URL',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      optionalApiKey: true,
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      envVarNames: [],
      upstreamBaseUrlEnvVarName: 'OLLAMA_BASE_URL',
      optionalApiKey: true,
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      envVarNames: ['LMSTUDIO_API_KEY'],
      upstreamBaseUrlEnvVarName: 'LMSTUDIO_BASE_URL',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      optionalApiKey: true,
      allowedPaths: OPENAI_COMPATIBLE_INFERENCE_PATHS,
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      // ChatGPT subscription: the gateway holds the OAuth record, mints a
      // fresh access token per request, adds the account-id header, and
      // collapses the request to the Codex backend — mirroring the OpenCode
      // Codex plugin, but server-side so the OAuth record stays out of the
      // sandbox. The Codex plugin forwards the request body unchanged, so no
      // body translation is needed here.
      id: CHATGPT_GATEWAY_PROVIDER_ID,
      name: 'ChatGPT Subscription',
      authStrategy: 'chatgpt-oauth',
      envVarNames: [],
      upstreamBaseUrl: CHATGPT_CODEX_UPSTREAM_BASE_URL,
      collapseToPath: CHATGPT_CODEX_UPSTREAM_PATH,
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: [
        '/responses',
        '/v1/responses',
        '/chat/completions',
        '/v1/chat/completions',
      ],
      openCodeBaseUrlSuffix: '/v1',
    },
  ];

/**
 * Env var names of provider keys the gateway replaces. When the gateway is
 * enabled these keys stay on the control plane instead of entering sandbox
 * env vars.
 */
export const INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES: readonly string[] =
  INFERENCE_GATEWAY_PROVIDERS.flatMap((provider) => provider.envVarNames);

export function getInferenceGatewayProvider(
  providerId: string,
): InferenceGatewayProvider | undefined {
  return INFERENCE_GATEWAY_PROVIDERS.find(
    (provider) => provider.id === providerId,
  );
}

const INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAME_SET = new Set(
  INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES,
);

/** True when `envVarName` is a provider key the gateway can serve. */
export function isInferenceGatewayCoveredEnvVar(envVarName: string): boolean {
  return INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAME_SET.has(envVarName);
}

/**
 * Resolve the gateway provider that owns a given key env-var name. Used by the
 * worker to map the withheld/served key list back to the providers it must
 * rebase onto the gateway.
 */
export function getInferenceGatewayProviderByEnvVarName(
  envVarName: string,
): InferenceGatewayProvider | undefined {
  return INFERENCE_GATEWAY_PROVIDERS.find((provider) =>
    provider.envVarNames.includes(envVarName),
  );
}

/** Parse the comma-separated `R_INFERENCE_GATEWAY_KEYS` value into a list. */
export function parseInferenceGatewayKeys(
  value: string | undefined | null,
): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Strip trailing slashes without a backtracking-prone anchored regex
 * (`/\/+$/` trips CodeQL's polynomial-ReDoS heuristic on untrusted input).
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }

  return value.slice(0, end);
}

/**
 * The OpenCode `baseURL` override pointing a provider's SDK at the gateway:
 * `<gatewayUrl>/<providerId><sdk base-path suffix>`.
 */
export function buildInferenceGatewayOpenCodeBaseUrl(
  gatewayUrl: string,
  provider: InferenceGatewayProvider,
): string {
  return `${stripTrailingSlashes(gatewayUrl)}/${provider.id}${provider.openCodeBaseUrlSuffix}`;
}

/**
 * The gateway base URL for a deployment, derived from the sandbox-reachable
 * platform API URL (the same base workers use for tRPC).
 */
export function buildInferenceGatewayUrl(platformApiUrl: string): string {
  return `${stripTrailingSlashes(platformApiUrl)}/api/inference`;
}

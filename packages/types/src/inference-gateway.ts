import type { SetupModelProviderId } from './model-provider-config';

/**
 * Sandbox-facing env var carrying the gateway base URL (e.g.
 * `https://api.example.com/api/inference`). Emitted by the control plane at
 * dequeue when the InferenceGateway feature flag is enabled; its presence is
 * what switches the worker's OpenCode config onto the gateway.
 */
export const INFERENCE_GATEWAY_URL_ENV_VAR_NAME = 'R_INFERENCE_GATEWAY_URL';

/**
 * OpenCode registers Bedrock models under this provider id (an
 * Anthropic-compatible endpoint), distinct from the `amazon-bedrock` setup
 * provider id.
 */
export const BEDROCK_MANTLE_OPENCODE_PROVIDER_ID = 'bedrock-mantle';

/** Matches valid cloud regions like `us-east-1`. */
export const INFERENCE_GATEWAY_REGION_PATTERN =
  /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u;

interface InferenceGatewayAuthHeader {
  name: string;
  scheme?: 'bearer';
}

export interface InferenceGatewayProvider {
  /**
   * Provider id, used both as the gateway path segment and as the OpenCode
   * provider id (they match for every supported provider).
   */
  id: SetupModelProviderId | typeof BEDROCK_MANTLE_OPENCODE_PROVIDER_ID;
  name: string;
  /**
   * Deployment env vars holding the provider API key the gateway injects,
   * in precedence order.
   */
  envVarNames: readonly string[];
  /**
   * Upstream API base. May contain a `{region}` placeholder resolved
   * per-request from `region` below.
   */
  upstreamBaseUrl: string;
  /**
   * Region resolution for `{region}`-templated upstreams: the deployment env
   * var to read and the fallback when it is unset.
   */
  region?: { envVarName: string; default: string };
  /** How the upstream expects its API key when the gateway forwards. */
  authHeader: InferenceGatewayAuthHeader;
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
 * HTTP-proxyable providers only: providers that need request signing
 * (Vertex service accounts) or client-managed OAuth refresh (ChatGPT
 * subscriptions) are handled separately. Upstream bases follow models.dev,
 * the registry OpenCode itself resolves providers from.
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
      envVarNames: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
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
      region: { envVarName: 'AWS_REGION', default: 'us-east-1' },
      authHeader: { name: 'x-api-key' },
      allowedPaths: ANTHROPIC_COMPATIBLE_INFERENCE_PATHS,
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

/**
 * The OpenCode `baseURL` override pointing a provider's SDK at the gateway:
 * `<gatewayUrl>/<providerId><sdk base-path suffix>`.
 */
export function buildInferenceGatewayOpenCodeBaseUrl(
  gatewayUrl: string,
  provider: InferenceGatewayProvider,
): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/${provider.id}${provider.openCodeBaseUrlSuffix}`;
}

/**
 * The gateway base URL for a deployment, derived from the sandbox-reachable
 * platform API URL (the same base workers use for tRPC).
 */
export function buildInferenceGatewayUrl(platformApiUrl: string): string {
  return `${platformApiUrl.replace(/\/+$/, '')}/api/inference`;
}

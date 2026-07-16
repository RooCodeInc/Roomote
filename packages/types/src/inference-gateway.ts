import type { SetupModelProviderId } from './model-provider-config';

/**
 * Sandbox-facing env var carrying the gateway base URL (e.g.
 * `https://api.example.com/api/inference`). Emitted by the control plane at
 * dequeue when the InferenceGateway feature flag is enabled; its presence is
 * what switches the worker's OpenCode config onto the gateway.
 */
export const INFERENCE_GATEWAY_URL_ENV_VAR_NAME = 'R_INFERENCE_GATEWAY_URL';

interface InferenceGatewayAuthHeader {
  name: string;
  scheme?: 'bearer';
}

export interface InferenceGatewayProvider {
  /**
   * Provider id, used both as the gateway path segment and as the OpenCode
   * provider id (they match for every supported provider).
   */
  id: SetupModelProviderId;
  name: string;
  /** Deployment env var holding the provider API key the gateway injects. */
  envVarName: string;
  upstreamBaseUrl: string;
  /** How the upstream expects its API key when the gateway forwards. */
  authHeader: InferenceGatewayAuthHeader;
  /**
   * Upstream path prefixes the gateway forwards. Everything else is rejected
   * so a run token can only reach inference endpoints, never the provider's
   * account, billing, or admin surface.
   */
  allowedPathPrefixes: readonly string[];
  /**
   * Base-path suffix the provider's SDK expects on a baseURL override,
   * mirroring the upstream default base path (the SDK appends endpoint paths
   * like `/messages` or `/chat/completions` below it).
   */
  openCodeBaseUrlSuffix: string;
}

/**
 * Providers reachable through the inference gateway. Key-authenticated
 * HTTP-proxyable providers only: providers that need request signing
 * (Vertex service accounts) or client-managed OAuth refresh (ChatGPT
 * subscriptions) are handled separately.
 */
export const INFERENCE_GATEWAY_PROVIDERS: readonly InferenceGatewayProvider[] =
  [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      envVarName: 'OPENROUTER_API_KEY',
      upstreamBaseUrl: 'https://openrouter.ai/api',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPathPrefixes: ['/v1'],
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      envVarName: 'ANTHROPIC_API_KEY',
      upstreamBaseUrl: 'https://api.anthropic.com',
      authHeader: { name: 'x-api-key' },
      allowedPathPrefixes: ['/v1/messages', '/v1/models'],
      openCodeBaseUrlSuffix: '/v1',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      envVarName: 'OPENAI_API_KEY',
      upstreamBaseUrl: 'https://api.openai.com',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPathPrefixes: [
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
      envVarName: 'GEMINI_API_KEY',
      upstreamBaseUrl: 'https://generativelanguage.googleapis.com',
      authHeader: { name: 'x-goog-api-key' },
      allowedPathPrefixes: ['/v1beta/models', '/v1/models'],
      openCodeBaseUrlSuffix: '/v1beta',
    },
  ];

/**
 * Env var names of provider keys the gateway replaces. When the gateway is
 * enabled these keys stay on the control plane instead of entering sandbox
 * env vars.
 */
export const INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES: readonly string[] =
  INFERENCE_GATEWAY_PROVIDERS.map((provider) => provider.envVarName);

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

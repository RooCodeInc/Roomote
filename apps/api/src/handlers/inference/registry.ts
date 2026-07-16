import type { SetupModelProviderId } from '@roomote/types';

/**
 * How an upstream provider expects its API key: the header to set and whether
 * the value is Bearer-prefixed or sent raw.
 */
interface InferenceProviderAuthHeader {
  name: string;
  scheme?: 'bearer';
}

interface InferenceProviderDefinition {
  id: SetupModelProviderId;
  name: string;
  upstreamBaseUrl: string;
  /** Deployment env vars holding the provider API key, in precedence order. */
  envVarNames: readonly string[];
  authHeader: InferenceProviderAuthHeader;
  /**
   * Upstream path prefixes the gateway forwards. Everything else is rejected
   * so a run token can only reach inference endpoints, never the provider's
   * account, billing, or admin surface.
   */
  allowedPaths: readonly string[];
}

/**
 * Providers reachable through the inference gateway. Key-authenticated
 * HTTP-proxyable providers only: providers that need request signing
 * (Vertex service accounts) or client-managed OAuth refresh (ChatGPT
 * subscriptions) are handled separately.
 */
const INFERENCE_PROVIDERS: readonly InferenceProviderDefinition[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    upstreamBaseUrl: 'https://openrouter.ai/api',
    envVarNames: ['OPENROUTER_API_KEY'],
    authHeader: { name: 'authorization', scheme: 'bearer' },
    allowedPaths: [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/models',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    upstreamBaseUrl: 'https://api.anthropic.com',
    envVarNames: ['ANTHROPIC_API_KEY'],
    authHeader: { name: 'x-api-key' },
    allowedPaths: ['/v1/messages', '/v1/messages/count_tokens', '/v1/models'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    upstreamBaseUrl: 'https://api.openai.com',
    envVarNames: ['OPENAI_API_KEY'],
    authHeader: { name: 'authorization', scheme: 'bearer' },
    allowedPaths: [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/embeddings',
      '/v1/models',
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    upstreamBaseUrl: 'https://generativelanguage.googleapis.com',
    envVarNames: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    authHeader: { name: 'x-goog-api-key' },
    allowedPaths: ['/v1beta/models', '/v1/models'],
  },
];

export function getInferenceProvider(
  providerId: string,
): InferenceProviderDefinition | undefined {
  return INFERENCE_PROVIDERS.find((provider) => provider.id === providerId);
}

/**
 * A path is allowed when it exactly matches an inference endpoint. Google
 * model routes are the exception because their model ID and action are part
 * of the nested path; their provider API has no account surface below models.
 */
export function isInferencePathAllowed(
  provider: InferenceProviderDefinition,
  upstreamPath: string,
): boolean {
  return provider.allowedPaths.some((path) => {
    if (upstreamPath === path) {
      return true;
    }

    return provider.id === 'google' && upstreamPath.startsWith(`${path}/`);
  });
}

export function formatProviderAuthHeaderValue(
  provider: InferenceProviderDefinition,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

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
  /** Deployment env var holding the provider API key. */
  envVarName: string;
  authHeader: InferenceProviderAuthHeader;
  /**
   * Upstream path prefixes the gateway forwards. Everything else is rejected
   * so a run token can only reach inference endpoints, never the provider's
   * account, billing, or admin surface.
   */
  allowedPathPrefixes: readonly string[];
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
    envVarName: 'OPENROUTER_API_KEY',
    authHeader: { name: 'authorization', scheme: 'bearer' },
    allowedPathPrefixes: ['/v1'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    upstreamBaseUrl: 'https://api.anthropic.com',
    envVarName: 'ANTHROPIC_API_KEY',
    authHeader: { name: 'x-api-key' },
    allowedPathPrefixes: ['/v1/messages', '/v1/models'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    upstreamBaseUrl: 'https://api.openai.com',
    envVarName: 'OPENAI_API_KEY',
    authHeader: { name: 'authorization', scheme: 'bearer' },
    allowedPathPrefixes: [
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
    envVarName: 'GEMINI_API_KEY',
    authHeader: { name: 'x-goog-api-key' },
    allowedPathPrefixes: ['/v1beta/models', '/v1/models'],
  },
];

export function getInferenceProvider(
  providerId: string,
): InferenceProviderDefinition | undefined {
  return INFERENCE_PROVIDERS.find((provider) => provider.id === providerId);
}

/**
 * A path is allowed when it equals an allowed prefix or nests under it with a
 * `/` separator, so `/v1/messages-admin` cannot ride on a `/v1/messages`
 * allowance while `/v1beta/models/gemini-2.5-pro:streamGenerateContent`
 * passes under `/v1beta/models`.
 */
export function isInferencePathAllowed(
  provider: InferenceProviderDefinition,
  upstreamPath: string,
): boolean {
  return provider.allowedPathPrefixes.some(
    (prefix) =>
      upstreamPath === prefix || upstreamPath.startsWith(`${prefix}/`),
  );
}

export function formatProviderAuthHeaderValue(
  provider: InferenceProviderDefinition,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

import {
  getInferenceGatewayProvider,
  INFERENCE_GATEWAY_REGION_PATTERN,
  type InferenceGatewayProvider,
} from '@roomote/types';
import { resolveModelProviderEnvValue } from '@roomote/db/server';

export function getInferenceProvider(
  providerId: string,
): InferenceGatewayProvider | undefined {
  return getInferenceGatewayProvider(providerId);
}

/**
 * A path is allowed when it exactly matches an inference endpoint. Providers
 * whose route shape requires it (Google model routes, Vercel's AI Gateway
 * protocol) additionally allow nested paths; their upstreams serve no
 * account surface below the allowed prefixes.
 */
export function isInferencePathAllowed(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
): boolean {
  return provider.allowedPaths.some((path) => {
    if (upstreamPath === path) {
      return true;
    }

    return (
      provider.allowNestedPaths === true && upstreamPath.startsWith(`${path}/`)
    );
  });
}

/**
 * Resolve the provider's upstream base, substituting the `{region}`
 * placeholder from the deployment's region env var (falling back to the
 * provider default) for region-templated upstreams like Bedrock.
 */
export async function resolveProviderUpstreamBaseUrl(
  provider: InferenceGatewayProvider,
): Promise<string> {
  if (!provider.region) {
    return provider.upstreamBaseUrl;
  }

  const region =
    (await resolveModelProviderEnvValue([provider.region.envVarName])) ??
    provider.region.default;

  if (!INFERENCE_GATEWAY_REGION_PATTERN.test(region)) {
    throw new Error(
      `${provider.region.envVarName} must be a valid region for ${provider.name}. Received "${region}".`,
    );
  }

  return provider.upstreamBaseUrl.replace('{region}', region);
}

export function formatProviderAuthHeaderValue(
  provider: InferenceGatewayProvider,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

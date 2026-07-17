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
 *
 * Paths containing dot segments or percent-encoded slashes are always rejected
 * first: the match runs on the WHATWG-parsed pathname (which preserves `%2F`
 * and does not collapse `%2e%2e`), so a nested-path provider could otherwise
 * pass `/v1beta/models/..%2F..%2Fadmin` through the `startsWith` check and
 * have the upstream normalize it back out of the inference surface.
 */
export function isInferencePathAllowed(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
): boolean {
  if (hasTraversalOrEncodedSlash(upstreamPath)) {
    return false;
  }

  return provider.allowedPaths.some((path) => {
    if (upstreamPath === path) {
      return true;
    }

    return (
      provider.allowNestedPaths === true && upstreamPath.startsWith(`${path}/`)
    );
  });
}

function hasTraversalOrEncodedSlash(upstreamPath: string): boolean {
  const lowered = upstreamPath.toLowerCase();

  if (lowered.includes('%2f') || lowered.includes('%5c')) {
    return true;
  }

  // Any `.` or `..` path segment (literal or percent-encoded dots) is out of
  // bounds for an inference endpoint allowlist.
  return lowered
    .replace(/%2e/g, '.')
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
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

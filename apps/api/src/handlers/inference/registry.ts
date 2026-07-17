import {
  CHATGPT_ACCOUNT_ID_HEADER,
  getInferenceGatewayProvider,
  INFERENCE_GATEWAY_REGION_PATTERN,
  type InferenceGatewayProvider,
} from '@roomote/types';
import {
  getFreshChatGptAccessToken,
  resolveModelProviderEnvValue,
} from '@roomote/db/server';

export function getInferenceProvider(
  providerId: string,
): InferenceGatewayProvider | undefined {
  return getInferenceGatewayProvider(providerId);
}

/** The upstream URL and auth headers the gateway forwards for one request. */
export interface ResolvedGatewayUpstream {
  upstreamUrl: string;
  headers: Record<string, string>;
}

export type GatewayUpstreamResolution =
  | { ok: true; resolved: ResolvedGatewayUpstream }
  | { ok: false; status: 404 | 500; error: string };

/**
 * Resolve the upstream URL and auth headers for a gateway request, per the
 * provider's auth strategy:
 * - `api-key`: inject the deployment's static key at the request path.
 * - `chatgpt-oauth`: mint a fresh subscription access token, add the
 *   account-id header, and collapse the request onto the Codex backend.
 */
export async function resolveGatewayUpstream(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
  search: string,
): Promise<GatewayUpstreamResolution> {
  if (provider.authStrategy === 'chatgpt-oauth') {
    return resolveChatGptUpstream(provider);
  }

  const [apiKey, upstreamBaseUrl] = await Promise.all([
    resolveModelProviderEnvValue(provider.envVarNames),
    resolveProviderUpstreamBaseUrl(provider),
  ]);

  if (!apiKey) {
    return {
      ok: false,
      status: 404,
      error: `No ${provider.name} API key is configured for this deployment`,
    };
  }

  return {
    ok: true,
    resolved: {
      upstreamUrl: `${upstreamBaseUrl}${upstreamPath}${search}`,
      headers: {
        [provider.authHeader.name]: formatProviderAuthHeaderValue(
          provider,
          apiKey,
        ),
      },
    },
  };
}

async function resolveChatGptUpstream(
  provider: InferenceGatewayProvider,
): Promise<GatewayUpstreamResolution> {
  const token = await getFreshChatGptAccessToken();

  if (!token) {
    return {
      ok: false,
      status: 404,
      error: 'No connected ChatGPT subscription is available',
    };
  }

  const upstreamUrl = `${provider.upstreamBaseUrl}${provider.collapseToPath ?? ''}`;
  const headers: Record<string, string> = {
    [provider.authHeader.name]: formatProviderAuthHeaderValue(
      provider,
      token.access,
    ),
  };

  if (token.accountId) {
    headers[CHATGPT_ACCOUNT_ID_HEADER] = token.accountId;
  }

  return { ok: true, resolved: { upstreamUrl, headers } };
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
async function resolveProviderUpstreamBaseUrl(
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

function formatProviderAuthHeaderValue(
  provider: InferenceGatewayProvider,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

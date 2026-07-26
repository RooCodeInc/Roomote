import {
  CHATGPT_ACCOUNT_ID_HEADER,
  getInferenceGatewayProvider,
  INFERENCE_GATEWAY_REGION_PATTERN,
  type InferenceGatewayProvider,
} from '@roomote/types';
import {
  getFreshChatGptAccessToken,
  getFreshXaiAccessToken,
  getGitHubCopilotAccessToken,
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
 * - `xai-oauth`: prefer a connected Grok subscription access token, then
 *   fall back to `XAI_API_KEY`.
 */
export async function resolveGatewayUpstream(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
  search: string,
): Promise<GatewayUpstreamResolution> {
  if (provider.authStrategy === 'chatgpt-oauth') {
    return resolveChatGptUpstream(provider);
  }

  if (provider.authStrategy === 'github-copilot-oauth') {
    return resolveGitHubCopilotUpstream(provider, upstreamPath, search);
  }

  if (provider.authStrategy === 'xai-oauth') {
    return resolveXaiUpstream(provider, upstreamPath, search);
  }

  const [apiKey, upstreamBaseUrl] = await Promise.all([
    resolveModelProviderEnvValue(provider.envVarNames),
    resolveProviderUpstreamBaseUrl(provider),
  ]);

  if (!apiKey && !provider.optionalApiKey) {
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
      headers:
        apiKey && provider.authHeader
          ? {
              [provider.authHeader.name]: formatProviderAuthHeaderValue(
                provider,
                apiKey,
              ),
            }
          : {},
    },
  };
}

/**
 * xAI supports both SuperGrok OAuth and a BYOK API key. Prefer a connected
 * subscription (fresh access token) so subscription users never need a key;
 * fall back to the deployment key when only that is configured.
 */
async function resolveXaiUpstream(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
  search: string,
): Promise<GatewayUpstreamResolution> {
  const [oauthToken, apiKey, upstreamBaseUrl] = await Promise.all([
    getFreshXaiAccessToken(),
    resolveModelProviderEnvValue(provider.envVarNames),
    resolveProviderUpstreamBaseUrl(provider),
  ]);

  const bearer = oauthToken?.access ?? apiKey;

  if (!bearer) {
    return {
      ok: false,
      status: 404,
      error:
        'No connected xAI Grok subscription or XAI_API_KEY is available for this deployment',
    };
  }

  return {
    ok: true,
    resolved: {
      upstreamUrl: `${upstreamBaseUrl}${upstreamPath}${search}`,
      headers: provider.authHeader
        ? {
            [provider.authHeader.name]: formatProviderAuthHeaderValue(
              provider,
              bearer,
            ),
          }
        : {},
    },
  };
}

async function resolveGitHubCopilotUpstream(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
  search: string,
): Promise<GatewayUpstreamResolution> {
  const token = await getGitHubCopilotAccessToken();

  if (!token) {
    return {
      ok: false,
      status: 404,
      error: 'No connected GitHub Copilot subscription is available',
    };
  }

  return {
    ok: true,
    resolved: {
      upstreamUrl: `${provider.upstreamBaseUrl!}${upstreamPath}${search}`,
      headers: {
        authorization: `Bearer ${token}`,
        'User-Agent': 'roomote',
        'Openai-Intent': 'conversation-edits',
        'x-initiator': 'user',
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

  const upstreamUrl = `${provider.upstreamBaseUrl!}${provider.collapseToPath ?? ''}`;
  const headers: Record<string, string> = {
    [provider.authHeader!.name]: formatProviderAuthHeaderValue(
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
  if (provider.upstreamBaseUrlEnvVarName) {
    const configuredBaseUrl = await resolveModelProviderEnvValue([
      provider.upstreamBaseUrlEnvVarName,
    ]);

    if (!configuredBaseUrl) {
      throw new Error(
        `${provider.upstreamBaseUrlEnvVarName} must be configured for ${provider.name}.`,
      );
    }

    return validateDynamicUpstreamBaseUrl(
      configuredBaseUrl,
      provider.upstreamBaseUrlEnvVarName,
    );
  }

  if (!provider.region) {
    return provider.upstreamBaseUrl!;
  }

  const region =
    (await resolveModelProviderEnvValue([provider.region.envVarName])) ??
    provider.region.default;

  // Providers with discrete regional hosts select a base outright; the
  // `{region}` template and its cloud-region pattern do not apply to them.
  if (provider.region.baseUrls) {
    const baseUrl = provider.region.baseUrls[region];

    if (!baseUrl) {
      throw new Error(
        `${provider.region.envVarName} must be one of ${Object.keys(provider.region.baseUrls).join(', ')} for ${provider.name}. Received "${region}".`,
      );
    }

    return baseUrl;
  }

  if (!INFERENCE_GATEWAY_REGION_PATTERN.test(region)) {
    throw new Error(
      `${provider.region.envVarName} must be a valid region for ${provider.name}. Received "${region}".`,
    );
  }

  return provider.upstreamBaseUrl!.replace('{region}', region);
}

function validateDynamicUpstreamBaseUrl(
  value: string,
  envVarName: string,
): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envVarName} must be an absolute HTTP(S) URL.`);
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${envVarName} must be an HTTP(S) URL without credentials, query parameters, or fragments.`,
    );
  }

  const normalizedPath = stripDynamicEndpointVersionSuffix(url.pathname);
  url.pathname = normalizedPath;

  return url.toString().replace(/\/+$/u, '');
}

function stripDynamicEndpointVersionSuffix(pathname: string): string {
  let end = pathname.length;

  while (end > 0 && pathname.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }

  const withoutTrailingSlashes = pathname.slice(0, end);

  return withoutTrailingSlashes.endsWith('/v1')
    ? withoutTrailingSlashes.slice(0, -3) || '/'
    : withoutTrailingSlashes || '/';
}

function formatProviderAuthHeaderValue(
  provider: InferenceGatewayProvider,
  apiKey: string,
): string {
  return provider.authHeader?.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

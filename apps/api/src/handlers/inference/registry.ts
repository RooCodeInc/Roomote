import {
  getInferenceGatewayProvider,
  type InferenceGatewayProvider,
} from '@roomote/types';

export function getInferenceProvider(
  providerId: string,
): InferenceGatewayProvider | undefined {
  return getInferenceGatewayProvider(providerId);
}

/**
 * A path is allowed when it equals an allowed prefix or nests under it with a
 * `/` separator, so `/v1/messages-admin` cannot ride on a `/v1/messages`
 * allowance while `/v1beta/models/gemini-2.5-pro:streamGenerateContent`
 * passes under `/v1beta/models`.
 */
export function isInferencePathAllowed(
  provider: InferenceGatewayProvider,
  upstreamPath: string,
): boolean {
  return provider.allowedPathPrefixes.some(
    (prefix) =>
      upstreamPath === prefix || upstreamPath.startsWith(`${prefix}/`),
  );
}

export function formatProviderAuthHeaderValue(
  provider: InferenceGatewayProvider,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

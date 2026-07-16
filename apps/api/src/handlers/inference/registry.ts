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
 * A path is allowed when it exactly matches an inference endpoint. Google
 * model routes are the exception because their model ID and action are part
 * of the nested path; their provider API has no account surface below models.
 */
export function isInferencePathAllowed(
  provider: InferenceGatewayProvider,
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
  provider: InferenceGatewayProvider,
  apiKey: string,
): string {
  return provider.authHeader.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
}

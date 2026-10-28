import {
  mapBrainModelName,
  type ResolvedBrainInference,
} from '@roomote/sdk/server';

/**
 * Rewrite the requested model into the resolved provider's naming. The Brain
 * always speaks OpenAI model names; the deployment may route through
 * OpenRouter, which namespaces the same models by vendor.
 */
export async function rewriteBody(
  rawBody: string,
  resolved: ResolvedBrainInference,
): Promise<string> {
  if (!rawBody) {
    return rawBody;
  }

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    if (typeof parsed.model !== 'string') {
      return rawBody;
    }

    return JSON.stringify({
      ...parsed,
      model: mapBrainModelName(parsed.model, resolved),
    });
  } catch {
    return rawBody;
  }
}

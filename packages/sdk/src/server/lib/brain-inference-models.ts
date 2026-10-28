import { Env } from '@roomote/env';

import { MODEL_TRANSLATIONS } from './brain-inference-model-names';
import type { ResolvedBrainInference } from './brain-inference-provider';

/**
 * Rewrite the model name the Brain asked for into the one this deployment
 * should actually call.
 *
 * The Brain always speaks OpenAI's names because it is an OpenAI-compatible
 * client. For the synthesis model only, `R_BRAIN_MODEL` wins outright. An
 * unrecognized model with no override passes through untouched.
 */
export function mapBrainModelName(
  requested: string,
  resolved: ResolvedBrainInference,
): string {
  const normalized = requested.trim();
  const row = MODEL_TRANSLATIONS.find(
    (entry) => entry.openai === normalized || entry.openrouter === normalized,
  );

  if (!row) {
    return normalized;
  }

  // Deliberately no embedding override here. Which embedding model runs is
  // fixed when the Brain is created, because its output width sizes a vector
  // column that cannot be resized in place.
  if (row.kind === 'chat') {
    const override = Env.R_BRAIN_MODEL?.trim();

    if (override) {
      return override;
    }
  }

  return resolved.providerId === 'openrouter' ? row.openrouter : row.openai;
}
